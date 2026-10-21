/**
 * Read a Drive file's TEXT, whatever it is stored as.
 *
 * Google files export straight to text. Plain-text files download as they are. PDFs and
 * Office files have no text export, so Drive converts them: a temporary Google copy is
 * made (Drive runs OCR on PDFs and images while converting), exported as text, then
 * permanently deleted. No parsing library runs here — the conversion is Drive's own.
 *
 * The temporary copy goes to the root of your My Drive, never the original's folder, so
 * people sharing that folder do not see it appear.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { call, download } from '../../google/client.js';
import { isTextFile } from '../../executor/file-output.js';

const GOOGLE_DOC = 'application/vnd.google-apps.document';
const GOOGLE_SHEET = 'application/vnd.google-apps.spreadsheet';
const GOOGLE_SLIDES = 'application/vnd.google-apps.presentation';

/** Native Google types and the text format each exports to. */
const EXPORT_AS: Record<string, string> = {
  [GOOGLE_DOC]: 'text/plain',
  [GOOGLE_SHEET]: 'text/csv',          // Drive exports the FIRST sheet only
  [GOOGLE_SLIDES]: 'text/plain',
};

/** Uploaded types Drive can convert, and the Google type each converts into. */
const CONVERT_TO: Record<string, string> = {
  'application/pdf': GOOGLE_DOC,
  'application/msword': GOOGLE_DOC,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': GOOGLE_DOC,
  'application/rtf': GOOGLE_DOC,
  'application/vnd.oasis.opendocument.text': GOOGLE_DOC,
  'image/jpeg': GOOGLE_DOC,
  'image/png': GOOGLE_DOC,
  'application/vnd.ms-excel': GOOGLE_SHEET,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': GOOGLE_SHEET,
  'application/vnd.oasis.opendocument.spreadsheet': GOOGLE_SHEET,
  'application/vnd.ms-powerpoint': GOOGLE_SLIDES,
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': GOOGLE_SLIDES,
  'application/vnd.oasis.opendocument.presentation': GOOGLE_SLIDES,
};

export interface ReadContentResult {
  name: string;
  mimeType: string;
  text: string;
  /** How the text was obtained. */
  via: 'export' | 'download' | 'conversion';
  truncated: boolean;
  totalChars: number;
  /** Set when the temporary conversion copy could not be removed. */
  leftover?: string;
}

async function fetchToString(
  method: 'files.export' | 'files.get',
  params: Record<string, unknown>,
  account: string,
): Promise<string> {
  const tmp = path.join(os.tmpdir(), `gws-read-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    await download('drive', method, params, tmp, { account });
    return await fs.readFile(tmp, 'utf-8');
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

export async function readDriveContent(
  account: string,
  fileId: string,
  maxChars: number,
  /** False under the read-only policy: the temporary copy is a write, however brief. */
  allowConversion = true,
): Promise<ReadContentResult> {
  const meta = await call('drive', 'files.get', {
    fileId, fields: 'id,name,mimeType,size', supportsAllDrives: true,
  }, { account }) as { name?: string; mimeType?: string };
  const name = String(meta.name ?? fileId);
  const mimeType = String(meta.mimeType ?? '');

  let text: string;
  let via: ReadContentResult['via'];
  let leftover: string | undefined;

  if (EXPORT_AS[mimeType]) {
    text = await fetchToString('files.export', { fileId, mimeType: EXPORT_AS[mimeType] }, account);
    via = 'export';
  } else if (isTextFile(name, mimeType)) {
    text = await fetchToString('files.get', { fileId, alt: 'media', supportsAllDrives: true }, account);
    via = 'download';
  } else if (CONVERT_TO[mimeType]) {
    if (!allowConversion) {
      throw new Error(
        `Reading "${name}" (${mimeType}) needs a temporary converted copy in Drive, which the ` +
        `read-only safety policy does not allow. Download it instead to get the original bytes.`,
      );
    }
    const target = CONVERT_TO[mimeType];
    let copy: { id?: string };
    try {
      copy = await call('drive', 'files.copy', {
        fileId, supportsAllDrives: true,
        name: `[temporary text extraction] ${name}`,
        mimeType: target,
        parents: ['root'],
      }, { account }) as { id?: string };
    } catch (err) {
      throw new Error(
        `Drive could not convert "${name}" (${mimeType}) to read its text: ` +
        `${err instanceof Error ? err.message : String(err)}. Reading a PDF or Office file needs ` +
        `write access to Drive (a temporary copy is made); download it instead to get the original bytes.`,
      );
    }
    if (!copy.id) throw new Error(`Drive returned no id for the temporary copy of "${name}".`);

    try {
      text = await fetchToString('files.export', { fileId: copy.id, mimeType: EXPORT_AS[target] }, account);
    } finally {
      // Always remove the copy, even when the export failed.
      try {
        await call('drive', 'files.delete', { fileId: copy.id, supportsAllDrives: true }, { account });
      } catch {
        leftover = copy.id;
      }
    }
    via = 'conversion';
  } else {
    throw new Error(
      `"${name}" is ${mimeType || 'of an unknown type'}, which has no text to read. ` +
      `Use download to save it to the workspace instead.`,
    );
  }

  // Exports start with a byte-order mark; it is not content.
  text = text.replace(/^﻿/, '');
  const totalChars = text.length;
  const truncated = totalChars > maxChars;
  return {
    name, mimeType, via, totalChars, truncated,
    text: truncated ? text.slice(0, maxChars) : text,
    ...(leftover ? { leftover } : {}),
  };
}
