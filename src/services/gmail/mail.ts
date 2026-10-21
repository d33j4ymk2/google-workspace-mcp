/**
 * Outbound mail: send, reply, reply-all, forward.
 *
 * The recipient logic below looks fussy. It is fussy because getting it wrong is
 * silent and embarrassing: a reply-all that mails the sender their own reply, or
 * that drops the one person who needed to see it. The rules are spelled out in
 * docs/design-notes/adr-103-helper-semantics.md — read them before changing any
 * of it.
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import { call, upload } from '../../google/client.js';
import { resolveWorkspacePath, verifyPathSafety } from '../../executor/workspace.js';
import { buildMimeMessage, lookupMimeType, type MimeAttachment } from './mime.js';

/**
 * Gmail's declared ceiling is 36,700,160 bytes for the ENCODED message. Base64
 * inflates by 4/3, so we cap the RAW attachment bytes well under it and let the
 * client's own descriptor-driven check (which knows the real declared maxSize) be
 * the backstop. Refusing here gives the caller a sentence instead of a 400.
 */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export interface SendOptions {
  to: string;
  subject: string;
  body: string;
  from?: string;
  cc?: string;
  bcc?: string;
  html?: boolean;
  /** Workspace filenames. */
  attachments?: string[];
  draft?: boolean;
}

/** Read workspace attachments, fenced by our own path safety check. */
async function loadAttachments(names: string[]): Promise<MimeAttachment[]> {
  const parts = await Promise.all(names.map(async (name) => {
    const filePath = resolveWorkspacePath(name);
    await verifyPathSafety(filePath);          // the workspace fence — attachments cannot escape it
    const data = await readFile(filePath);
    if (data.length === 0) {
      throw new Error(`Attachment "${name}" is empty (0 bytes). Gmail rejects empty parts.`);
    }
    return { filename: basename(filePath), contentType: lookupMimeType(filePath), data };
  }));

  const total = parts.reduce((n, p) => n + p.data.length, 0);
  if (total > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `Attachments total ${(total / 1e6).toFixed(1)} MB; the limit is ` +
      `${(MAX_ATTACHMENT_BYTES / 1e6).toFixed(0)} MB of raw bytes (base64 inflates by ~4/3 ` +
      `and Gmail's encoded ceiling is 35 MB).`,
    );
  }
  return parts;
}

/**
 * Deliver a built message.
 *
 * Uses the RESUMABLE upload endpoint, always — never `uploadType=multipart`, which
 * has no chunking and degrades at size. Resumable is verified (ADR-103 item 4) to
 * carry a 25 MB attachment — 34.2 MB encoded, 93% of Google's declared cap — and to
 * round-trip byte-for-byte.
 */
async function deliver(
  message: Buffer,
  account: string,
  draft: boolean,
  threadId?: string,
): Promise<Record<string, unknown>> {
  const resource = draft ? 'users.drafts.create' : 'users.messages.send';
  const metadata = threadId
    ? (draft ? { message: { threadId } } : { threadId })
    : {};

  const data = await upload('gmail', resource, { userId: 'me' }, {
    account,
    media: message,
    contentType: 'message/rfc822',
    metadata,
  }) as Record<string, unknown>;

  // Gmail returns the created resource, and its id is the only evidence the
  // send happened. Without one there is nothing to look the message up by, so
  // "sent" would be a claim rather than a fact — and sending is the one thing
  // here that cannot be checked afterwards or undone. Refuse to report success
  // we cannot stand behind.
  if (typeof data?.id !== 'string' || data.id === '') {
    throw new Error(
      `Gmail accepted the ${draft ? 'draft' : 'send'} request but returned no message id, ` +
      `so whether it ${draft ? 'was saved' : 'was sent'} cannot be confirmed. ` +
      'Check the mailbox before retrying — retrying may deliver it twice.',
    );
  }

  return data;
}

export async function sendMail(account: string, opts: SendOptions): Promise<Record<string, unknown>> {
  const attachments = opts.attachments?.length ? await loadAttachments(opts.attachments) : [];
  const message = buildMimeMessage({
    to: opts.to, subject: opts.subject, body: opts.body,
    from: opts.from, cc: opts.cc, bcc: opts.bcc, html: opts.html,
    attachments,
  });
  return deliver(message, account, opts.draft === true);
}

// --- Reply / reply-all / forward -------------------------------------------

interface OriginalMessage {
  id: string;
  threadId: string;
  messageId?: string;      // the RFC 5322 Message-ID header
  references?: string;
  subject: string;
  from: string;
  to: string;
  cc: string;
  replyTo?: string;
  date: string;
  bodyText: string;
}

const headerOf = (headers: Array<{ name: string; value: string }>, name: string): string =>
  headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

/** Walk the payload for the first text/plain body. */
function plainBody(payload: Record<string, unknown>): string {
  const mime = String(payload.mimeType ?? '');
  const body = payload.body as { data?: string } | undefined;
  if (mime === 'text/plain' && body?.data) {
    return Buffer.from(body.data, 'base64url').toString('utf-8');
  }
  for (const part of (payload.parts ?? []) as Array<Record<string, unknown>>) {
    const found = plainBody(part);
    if (found) return found;
  }
  return '';
}

async function fetchOriginal(account: string, messageId: string): Promise<OriginalMessage> {
  const msg = await call('gmail', 'users.messages.get',
    { userId: 'me', id: messageId, format: 'full' }, { account }) as Record<string, unknown>;
  const payload = msg.payload as Record<string, unknown>;
  const headers = (payload.headers ?? []) as Array<{ name: string; value: string }>;

  return {
    id: String(msg.id),
    threadId: String(msg.threadId),
    messageId: headerOf(headers, 'Message-ID') || undefined,
    references: headerOf(headers, 'References') || undefined,
    subject: headerOf(headers, 'Subject'),
    from: headerOf(headers, 'From'),
    to: headerOf(headers, 'To'),
    cc: headerOf(headers, 'Cc'),
    replyTo: headerOf(headers, 'Reply-To') || undefined,
    date: headerOf(headers, 'Date'),
    bodyText: plainBody(payload),
  };
}

/** `a@b.com`, `"Name" <a@b.com>` -> `a@b.com`, lowercased. The identity we compare on. */
function emailOf(address: string): string {
  const angled = address.match(/<([^>]+)>/);
  return (angled ? angled[1] : address).trim().toLowerCase();
}

const splitAddresses = (list: string): string[] =>
  list.split(',').map((a) => a.trim()).filter(Boolean);

/**
 * Enforce To > Cc > Bcc precedence and drop excluded/duplicate addresses.
 *
 * An address that appears in two fields survives only in the highest — otherwise
 * a recipient is mailed twice, and Gmail shows them in both lines.
 */
function dedupeRecipients(
  to: string[], cc: string[], excluded: Set<string>,
): { to: string[]; cc: string[] } {
  const seen = new Set<string>();
  const keep = (list: string[]) => list.filter((a) => {
    const key = emailOf(a);
    if (!key || excluded.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { to: keep(to), cc: keep(cc) };
}

/** `Re: ` unless it is already a reply. Case-insensitive, like Gmail. */
const rePrefix = (subject: string): string =>
  /^re:/i.test(subject.trim()) ? subject : `Re: ${subject}`;

const fwdPrefix = (subject: string): string =>
  /^fwd:/i.test(subject.trim()) ? subject : `Fwd: ${subject}`;

/** Quote the original, plain-text style. */
function quotePlain(o: OriginalMessage): string {
  const attribution = `On ${o.date}, ${o.from} wrote:`;
  const quoted = o.bodyText.split('\n').map((l) => `> ${l}`).join('\n');
  return `${attribution}\n${quoted}`;
}

export interface ReplyOptions {
  messageId: string;
  body: string;
  cc?: string;
  html?: boolean;
  attachments?: string[];
  draft?: boolean;
  /** reply-all only. */
  all?: boolean;
}

export async function replyMail(account: string, opts: ReplyOptions): Promise<Record<string, unknown>> {
  const original = await fetchOriginal(account, opts.messageId);

  // Who gets it. `Reply-To` wins over `From` when the sender asked for it.
  const primaryTo = original.replyTo || original.from;
  let to = splitAddresses(primaryTo);
  let cc = opts.cc ? splitAddresses(opts.cc) : [];

  const excluded = new Set<string>();
  if (opts.all) {
    // Never reply-all to yourself. The account's own address is excluded, or you
    // mail yourself a copy of your own reply — visibly, in the To line.
    excluded.add(emailOf(account));

    const iSentIt = emailOf(original.from) === emailOf(account);
    if (iSentIt) {
      // Replying-all to your OWN message: the people to reach are the ones you
      // originally wrote to, not yourself. Matches Gmail's web behaviour, and
      // Reply-To is ignored here on purpose.
      to = splitAddresses(original.to);
      cc = [...splitAddresses(original.cc), ...cc];
    } else {
      // Everyone else on the thread moves to Cc; the sender stays in To.
      cc = [...splitAddresses(original.to), ...splitAddresses(original.cc), ...cc];
    }
  }

  const recipients = dedupeRecipients(to, cc, excluded);
  if (recipients.to.length === 0) {
    throw new Error('No recipient remains after removing your own address. Nobody would receive this reply.');
  }

  const quoted = opts.html
    ? `${opts.body}<br><blockquote>${original.bodyText}</blockquote>`
    : `${opts.body}\n\n${quotePlain(original)}`;

  // Threading. In-Reply-To points at the parent; References carries the chain so
  // clients that do not know threadId can still build the tree.
  const references = [original.references, original.messageId].filter(Boolean).join(' ');

  const message = buildMimeMessage({
    to: recipients.to.join(', '),
    cc: recipients.cc.length ? recipients.cc.join(', ') : undefined,
    subject: rePrefix(original.subject),
    body: quoted,
    html: opts.html,
    attachments: opts.attachments?.length ? await loadAttachments(opts.attachments) : [],
    inReplyTo: original.messageId,
    references: references || undefined,
  });

  return deliver(message, account, opts.draft === true, original.threadId);
}

export interface ForwardOptions {
  messageId: string;
  to: string;
  body?: string;
  html?: boolean;
  draft?: boolean;
  /** Carry the original's attachments. Default true. */
  includeAttachments?: boolean;
}

/** Pull the original's real attachment bytes back out of Gmail. */
async function originalAttachments(account: string, original: OriginalMessage): Promise<MimeAttachment[]> {
  const msg = await call('gmail', 'users.messages.get',
    { userId: 'me', id: original.id, format: 'full' }, { account }) as Record<string, unknown>;

  const found: Array<{ filename: string; contentType: string; attachmentId: string }> = [];
  const walk = (part: Record<string, unknown>) => {
    const body = part.body as { attachmentId?: string } | undefined;
    if (part.filename && body?.attachmentId) {
      found.push({
        filename: String(part.filename),
        contentType: String(part.mimeType ?? 'application/octet-stream'),
        attachmentId: body.attachmentId,
      });
    }
    for (const p of (part.parts ?? []) as Array<Record<string, unknown>>) walk(p);
  };
  walk(msg.payload as Record<string, unknown>);

  return Promise.all(found.map(async (f) => {
    const att = await call('gmail', 'users.messages.attachments.get',
      { userId: 'me', messageId: original.id, id: f.attachmentId }, { account }) as { data: string };
    return {
      filename: f.filename,
      contentType: f.contentType,
      data: Buffer.from(att.data, 'base64url'),
    };
  }));
}

export async function forwardMail(account: string, opts: ForwardOptions): Promise<Record<string, unknown>> {
  const original = await fetchOriginal(account, opts.messageId);
  const attachments = opts.includeAttachments === false
    ? []
    : await originalAttachments(account, original);

  const header =
    `---------- Forwarded message ---------\n` +
    `From: ${original.from}\n` +
    (original.date ? `Date: ${original.date}\n` : '') +
    `Subject: ${original.subject}\n` +
    `To: ${original.to}\n` +
    (original.cc ? `Cc: ${original.cc}\n` : '') +
    `\n`;

  const body = `${opts.body ? `${opts.body}\n\n` : ''}${header}${original.bodyText}`;

  // A forward THREADS. It is a continuation of the message's identity, not a new
  // conversation, and this is what every mail client actually does.
  //
  // Measured, not assumed — an earlier version of this function did NOT thread,
  // on the confident but INVENTED belief that Gmail's web client starts a new
  // thread on forward. It does not. Checking real mail settled it: every forward
  // sent from this account carries In-Reply-To + References and shares the
  // original's threadId, and 20/20 forwards RECEIVED from other clients — Gmail,
  // Outlook/Exchange, Yahoo — carry the same headers. RFC 5322 §3.6.4 is the
  // mechanism; universal practice is the evidence.
  //
  // The forward lives in the sender's own thread, in the sender's own mailbox. The
  // original recipients never see it.
  const references = [original.references, original.messageId].filter(Boolean).join(' ');

  const message = buildMimeMessage({
    to: opts.to,
    subject: fwdPrefix(original.subject),
    body,
    html: opts.html,
    attachments,
    inReplyTo: original.messageId,
    references: references || undefined,
  });

  return deliver(message, account, opts.draft === true, original.threadId);
}

// --- Draft editing ---------------------------------------------------------

export interface UpdateDraftOptions {
  draftId: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  /** Replaces the whole body. Omit to keep the current one. */
  body?: string;
  /** Only meaningful with `body`: whether the new body is HTML. */
  html?: boolean;
  /** Workspace filenames to ADD to the attachments already on the draft. */
  attachments?: string[];
  /** Filenames of current attachments to drop. */
  removeAttachments?: string[];
}

/** First non-attachment part of a given type, raw (not sanitized): the body as stored. */
function rawBodyPart(part: Record<string, unknown>, mimeType: string): string | undefined {
  const body = part.body as { data?: string; attachmentId?: string } | undefined;
  if (part.mimeType === mimeType && !part.filename && body?.data) {
    return Buffer.from(body.data, 'base64url').toString('utf-8');
  }
  for (const p of (part.parts ?? []) as Array<Record<string, unknown>>) {
    const found = rawBodyPart(p, mimeType);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Rewrite a saved draft in place.
 *
 * Gmail has no partial update: drafts.update REPLACES the draft's message. So every
 * field the caller did not name is read back from the current draft and written again —
 * recipients, subject, body, From (a Send-As alias survives), the threading headers and
 * threadId (a reply draft stays a reply in its thread), and the existing attachments,
 * re-uploaded byte-for-byte. The draft id does not change.
 */
export async function updateDraft(account: string, opts: UpdateDraftOptions): Promise<Record<string, unknown>> {
  const draft = await call('gmail', 'users.drafts.get',
    { userId: 'me', id: opts.draftId, format: 'full' }, { account }) as Record<string, unknown>;
  const message = (draft.message ?? {}) as Record<string, unknown>;
  const payload = (message.payload ?? {}) as Record<string, unknown>;
  const headers = (payload.headers ?? []) as Array<{ name: string; value: string }>;
  const header = (name: string) => headerOf(headers, name) || undefined;

  let body = opts.body;
  let html = opts.html === true;
  if (body === undefined) {
    const existingHtml = rawBodyPart(payload, 'text/html');
    html = existingHtml !== undefined;
    body = existingHtml ?? rawBodyPart(payload, 'text/plain') ?? '';
  }

  // Current attachments, minus the ones asked to go. Inline images keep their
  // Content-ID so the HTML body's cid: references still resolve.
  const drop = new Set((opts.removeAttachments ?? []).map((n) => n.trim().toLowerCase()));
  const kept: Array<{ filename: string; contentType: string; attachmentId: string; contentId?: string }> = [];
  const seen = new Set<string>();
  const walk = (part: Record<string, unknown>) => {
    const partBody = part.body as { attachmentId?: string } | undefined;
    if (part.filename && partBody?.attachmentId) {
      const filename = String(part.filename);
      seen.add(filename.toLowerCase());
      if (!drop.has(filename.toLowerCase())) {
        const partHeaders = (part.headers ?? []) as Array<{ name: string; value: string }>;
        const cid = headerOf(partHeaders, 'Content-ID').replace(/^<|>$/g, '');
        kept.push({
          filename,
          contentType: String(part.mimeType ?? 'application/octet-stream'),
          attachmentId: partBody.attachmentId,
          ...(cid ? { contentId: cid } : {}),
        });
      }
    }
    for (const p of (part.parts ?? []) as Array<Record<string, unknown>>) walk(p);
  };
  walk(payload);

  const missing = [...drop].filter((n) => !seen.has(n));
  if (missing.length > 0) {
    throw new Error(
      `Draft ${opts.draftId} has no attachment named ${missing.map((n) => `"${n}"`).join(', ')}. ` +
      `Current attachments: ${[...seen].join(', ') || 'none'}.`,
    );
  }

  const existing: MimeAttachment[] = await Promise.all(kept.map(async (k) => {
    const att = await call('gmail', 'users.messages.attachments.get',
      { userId: 'me', messageId: String(message.id), id: k.attachmentId }, { account }) as { data: string };
    return {
      filename: k.filename,
      contentType: k.contentType,
      data: Buffer.from(att.data, 'base64url'),
      ...(k.contentId ? { contentId: k.contentId } : {}),
    };
  }));
  const added = opts.attachments?.length ? await loadAttachments(opts.attachments) : [];

  const to = opts.to ?? header('To') ?? '';
  const mime = buildMimeMessage({
    to,
    cc: opts.cc ?? header('Cc'),
    bcc: opts.bcc ?? header('Bcc'),
    from: header('From'),
    subject: opts.subject ?? header('Subject') ?? '',
    body,
    html,
    attachments: [...existing, ...added],
    inReplyTo: header('In-Reply-To'),
    references: header('References'),
  });

  const threadId = message.threadId ? String(message.threadId) : undefined;
  const data = await upload('gmail', 'users.drafts.update', { userId: 'me', id: opts.draftId }, {
    account,
    media: mime,
    contentType: 'message/rfc822',
    metadata: { id: opts.draftId, ...(threadId ? { message: { threadId } } : {}) },
  }) as Record<string, unknown>;

  if (typeof data?.id !== 'string' || data.id === '') {
    throw new Error(
      `Gmail accepted the draft update but returned no draft id, so whether draft ` +
      `${opts.draftId} was changed cannot be confirmed. Check it with getDraft before retrying.`,
    );
  }
  return {
    ...data,
    to,
    subject: opts.subject ?? header('Subject') ?? '',
    attachments: [...existing, ...added].map((a) => a.filename),
  };
}
