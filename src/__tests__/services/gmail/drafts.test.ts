/**
 * Drafts: listDrafts hydration + deleteDraft.
 *
 * Drafts are their own Gmail resource. users.drafts.list returns one bare
 * {id: draftId, message: {id, threadId}} per draft, and users.drafts.delete takes
 * the DRAFT id — not the message id a `search in:drafts` returns. The bugs this
 * suite guards against are the shape ones: a draft list that shows draft ids but
 * no recipient/subject (indistinguishable drafts), and a deleteDraft that is
 * handed a message id and does nothing while claiming success.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../google/client.js');
import { mockCall } from '../../server/handlers/__mocks__/client.js';

import { gmailPatch } from '../../../services/gmail/patch.js';
import type { PatchContext } from '../../../factory/types.js';

const ctx = { operation: 'listDrafts', params: {}, account: 'me@test.com' };

/** A draft's message, as users.messages.get (metadata format) returns it. */
function draftMessage(id: string, to = 'bob@test.com', subject = 'Hello'): Record<string, unknown> {
  return {
    id,
    threadId: 't-1',
    snippet: 'draft snippet',
    payload: { headers: [
      { name: 'From', value: 'me@test.com' },
      { name: 'To', value: to },
      { name: 'Subject', value: subject },
      { name: 'Date', value: 'Sun, 12 Jul 2026 10:00:00 -0500' },
    ] },
  };
}

beforeEach(() => mockCall.mockReset());

describe('listDrafts afterExecute', () => {
  it('hydrates each draft with recipient/subject/date, keeping the DRAFT id on the row', async () => {
    mockCall
      .mockResolvedValueOnce(draftMessage('m-1', 'bob@test.com', 'Invoice'))
      .mockResolvedValueOnce(draftMessage('m-2', 'carol@test.com', 'Draft reply'));

    const raw = {
      resultSizeEstimate: 2,
      drafts: [
        { id: 'r-111', message: { id: 'm-1', threadId: 't-1' } },
        { id: 'r-222', message: { id: 'm-2', threadId: 't-2' } },
      ],
    };
    const hydrated = await gmailPatch.afterExecute!.listDrafts(raw, ctx) as { drafts: Record<string, unknown>[] };

    // Hydration fetches by MESSAGE id, but the row is keyed by DRAFT id.
    expect(mockCall).toHaveBeenNthCalledWith(1, 'gmail', 'users.messages.get',
      expect.objectContaining({ userId: 'me', id: 'm-1', format: 'metadata' }),
      expect.objectContaining({ account: 'me@test.com' }));

    expect(hydrated.drafts).toEqual([
      expect.objectContaining({ draftId: 'r-111', messageId: 'm-1', to: 'bob@test.com', subject: 'Invoice' }),
      expect.objectContaining({ draftId: 'r-222', messageId: 'm-2', to: 'carol@test.com', subject: 'Draft reply' }),
    ]);
  });

  it('marks a draft it could not fetch, instead of rendering a blank row', async () => {
    mockCall.mockRejectedValueOnce(new Error('boom'));

    const raw = { drafts: [{ id: 'r-1', message: { id: 'm-1', threadId: 't-1' } }] };
    const hydrated = await gmailPatch.afterExecute!.listDrafts(raw, ctx) as { drafts: Record<string, unknown>[] };

    const row = hydrated.drafts[0];
    expect(row.draftId).toBe('r-1');
    expect(row.error).toBeTruthy();

    // And the reader SEES it in the list, not a draft with no recipient.
    const rendered = gmailPatch.formatList!({ drafts: hydrated.drafts }, ctx).text;
    expect(rendered).toContain('⚠');
    expect(rendered).toContain('r-1 |');
  });

  it('returns an empty list when there are no drafts', async () => {
    const hydrated = await gmailPatch.afterExecute!.listDrafts(
      { drafts: [], resultSizeEstimate: 0 }, ctx) as { drafts: unknown[] };
    expect(hydrated.drafts).toEqual([]);
    expect(mockCall).not.toHaveBeenCalled();
  });
});

describe('formatDraftList', () => {
  it('renders the DRAFT id first, so deleteDraft can be driven from the row', () => {
    const data = { drafts: [
      { draftId: 'r-111', messageId: 'm-1', to: 'bob@test.com', subject: 'Invoice', date: 'Sun, 12 Jul 2026 10:00:00 -0500' },
      { draftId: 'r-222', messageId: 'm-2', to: 'carol@test.com', subject: 'Draft reply', date: 'Mon, 13 Jul 2026 09:00:00 -0500' },
    ] };
    const result = gmailPatch.formatList!(data, ctx);

    expect(result.text).toContain('## Drafts (2)');
    expect(result.text).toContain('r-111 | bob@test.com | Invoice');
    expect(result.text).toContain('r-222 | carol@test.com | Draft reply');
    expect(result.refs).toMatchObject({
      count: 2,
      draftId: 'r-111',
      draftIds: ['r-111', 'r-222'],
      messageIds: ['m-1', 'm-2'],
    });
  });

  it('renders an empty state, not an error, when the list is empty', () => {
    const ctxEmpty: PatchContext = { ...ctx, params: {} };
    const result = gmailPatch.formatList!({ drafts: [], resultSizeEstimate: 0 }, ctxEmpty);
    expect(result.text).toBe('No drafts found.');
    expect(result.refs).toEqual({ count: 0 });
  });
});

describe('deleteDraft custom handler', () => {
  it('deletes by DRAFT id and confirms with that id', async () => {
    // Google answers a successful drafts.delete with an empty 204 body.
    mockCall.mockResolvedValueOnce({});

    const handler = gmailPatch.customHandlers!.deleteDraft!;
    const result = await handler({ draftId: 'r-111' }, 'me@test.com');

    expect(mockCall).toHaveBeenCalledWith(
      'gmail',
      'users.drafts.delete',
      { userId: 'me', id: 'r-111' },
      expect.objectContaining({ account: 'me@test.com' }),
    );
    expect(result.text).toContain('r-111');
    expect(result.refs).toEqual({ draftId: 'r-111', deleted: true });
  });

  it('refuses to delete without a draft id', async () => {
    const handler = gmailPatch.customHandlers!.deleteDraft!;
    await expect(handler({}, 'me@test.com')).rejects.toThrow(/draftId/);
    expect(mockCall).not.toHaveBeenCalled();
  });
});

// --- getDraft / updateDraft ------------------------------------------------

import { mockUpload } from '../../server/handlers/__mocks__/client.js';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const b64 = (s: string) => Buffer.from(s, 'utf-8').toString('base64url');

/** A reply draft as users.drafts.get (format=full) returns it: body + one PDF. */
function fullDraft(opts: { html?: boolean } = {}): Record<string, unknown> {
  const bodyPart = opts.html
    ? { mimeType: 'text/html', filename: '', body: { data: b64('<p>Hi <b>Bob</b></p>') } }
    : { mimeType: 'text/plain', filename: '', body: { data: b64('Hi Bob,\nsee attached.') } };
  return {
    id: 'r-777',
    message: {
      id: 'm-777',
      threadId: 't-thread',
      payload: {
        mimeType: 'multipart/mixed',
        headers: [
          { name: 'From', value: 'Me <alias@test.com>' },
          { name: 'To', value: 'bob@test.com' },
          { name: 'Cc', value: 'carol@test.com' },
          { name: 'Subject', value: 'Re: Invoice' },
          { name: 'In-Reply-To', value: '<orig@mail.test>' },
          { name: 'References', value: '<root@mail.test> <orig@mail.test>' },
        ],
        parts: [
          bodyPart,
          { mimeType: 'application/pdf', filename: 'invoice.pdf', headers: [], body: { attachmentId: 'att-1', size: 3 } },
        ],
      },
    },
  };
}

/** The RFC 822 message handed to the Nth upload. */
const uploaded = (n = 0) => (mockUpload.mock.calls[n][3].media as Buffer).toString('utf-8');

describe('updateDraft', () => {
  const handler = gmailPatch.customHandlers!.updateDraft;

  beforeEach(() => {
    mockUpload.mockReset();
    mockUpload.mockResolvedValue({ id: 'r-777', message: { id: 'm-778', threadId: 't-thread' } });
  });

  function mockDraftReads(draft = fullDraft()) {
    mockCall.mockImplementation(async (_svc, method) => {
      if (method === 'users.drafts.get') return draft;
      if (method === 'users.messages.attachments.get') return { data: Buffer.from('PDF').toString('base64url') };
      // The file-level beforeEach returns mockCall from mockReset(), and vitest calls
      // a hook's return value as its cleanup: that arrives here with no arguments.
      if (method === undefined) return undefined;
      throw new Error(`unexpected ${String(method)}`);
    });
  }

  it('changes only the subject and keeps everything else, in the same draft and thread', async () => {
    mockDraftReads();
    const res = await handler({ draftId: 'r-777', subject: 'Re: Invoice (corrected)' }, 'me@test.com');

    expect(mockUpload).toHaveBeenCalledWith('gmail', 'users.drafts.update',
      { userId: 'me', id: 'r-777' },
      expect.objectContaining({ account: 'me@test.com', metadata: { id: 'r-777', message: { threadId: 't-thread' } } }));

    const mime = uploaded();
    expect(mime).toContain('Subject: Re: Invoice (corrected)');
    expect(mime).toContain('To: bob@test.com');
    expect(mime).toContain('Cc: carol@test.com');
    expect(mime).toContain('alias@test.com');                       // Send-As alias kept
    expect(mime).toContain('In-Reply-To: <orig@mail.test>');         // still a reply
    expect(mime).toContain('References: <root@mail.test> <orig@mail.test>');
    expect(mime).toContain(Buffer.from('Hi Bob,\nsee attached.').toString('base64'));
    expect(mime).toContain('filename="invoice.pdf"');                // attachment re-uploaded
    expect(mime).toContain(Buffer.from('PDF').toString('base64'));
    expect(res.text).toContain('not sent');
    expect(res.refs.draftId).toBe('r-777');
  });

  it('replaces the body when one is given', async () => {
    mockDraftReads();
    await handler({ draftId: 'r-777', body: 'New text' }, 'me@test.com');
    const mime = uploaded();
    expect(mime).toContain(Buffer.from('New text').toString('base64'));
    expect(mime).not.toContain(Buffer.from('Hi Bob,\nsee attached.').toString('base64'));
  });

  it('keeps an HTML body as HTML when the body is not touched', async () => {
    mockDraftReads(fullDraft({ html: true }));
    await handler({ draftId: 'r-777', to: 'dave@test.com' }, 'me@test.com');
    const mime = uploaded();
    expect(mime).toContain('Content-Type: text/html');
    expect(mime).toContain(Buffer.from('<p>Hi <b>Bob</b></p>').toString('base64'));
    expect(mime).toContain('To: dave@test.com');
  });

  it('removes a named attachment and refuses a name the draft does not have', async () => {
    mockDraftReads();
    await handler({ draftId: 'r-777', removeAttachments: 'Invoice.PDF' }, 'me@test.com');
    expect(uploaded()).not.toContain('invoice.pdf');

    await expect(handler({ draftId: 'r-777', removeAttachments: 'nope.txt' }, 'me@test.com'))
      .rejects.toThrow(/no attachment named "nope.txt".*invoice\.pdf/);
    expect(mockUpload).toHaveBeenCalledTimes(1);                      // the bad call uploaded nothing
  });

  it('adds a workspace file alongside the existing attachment', async () => {
    const saved = process.env.WORKSPACE_DIR;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gws-draft-'));
    process.env.WORKSPACE_DIR = dir;
    try {
      await fs.writeFile(path.join(dir, 'notes.txt'), 'extra');
      mockDraftReads();
      const res = await handler({ draftId: 'r-777', attachments: 'notes.txt' }, 'me@test.com');
      const mime = uploaded();
      expect(mime).toContain('filename="invoice.pdf"');
      expect(mime).toContain('filename="notes.txt"');
      expect(res.refs.attachments).toEqual(['invoice.pdf', 'notes.txt']);
    } finally {
      if (saved === undefined) delete process.env.WORKSPACE_DIR; else process.env.WORKSPACE_DIR = saved;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('getDraft', () => {
  it('shows the draft id with the message content', async () => {
    mockCall.mockResolvedValueOnce(fullDraft());
    const res = await gmailPatch.customHandlers!.getDraft({ draftId: 'r-777' }, 'me@test.com');
    expect(mockCall).toHaveBeenCalledWith('gmail', 'users.drafts.get',
      { userId: 'me', id: 'r-777', format: 'full' }, expect.objectContaining({ account: 'me@test.com' }));
    expect(res.text).toContain('**Draft ID:** r-777');
    expect(res.text).toContain('Re: Invoice');
    expect(res.text).toContain('see attached');
    expect(res.refs.draftId).toBe('r-777');
  });
});
