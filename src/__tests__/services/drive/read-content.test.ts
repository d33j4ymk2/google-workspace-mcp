/**
 * Drive `read`: text out of any file type, with the temporary conversion copy always
 * cleaned up and never placed in the original's (possibly shared) folder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';

vi.mock('../../../google/client.js');
import { mockCall, mockDownload } from '../../server/handlers/__mocks__/client.js';
import { readDriveContent } from '../../../services/drive/read-content.js';
import { drivePatch } from '../../../services/drive/patch.js';
import { configurePolicies, readOnly } from '../../../factory/safety.js';

/** Make download() write `text` to whatever path it is given. */
function downloadsText(text: string) {
  mockDownload.mockImplementation(async (_s, _m, _p, outputPath) => {
    await fs.writeFile(outputPath, text);
    return outputPath;
  });
}

function metaThenCopy(mimeType: string, name = 'Contract.pdf') {
  mockCall.mockImplementation(async (_svc, method) => {
    if (method === 'files.get') return { id: 'f1', name, mimeType };
    if (method === 'files.copy') return { id: 'tmp1' };
    if (method === 'files.delete') return {};
    if (method === undefined) return undefined; // a hook's cleanup call
    throw new Error(`unexpected ${String(method)}`);
  });
}

beforeEach(() => { mockCall.mockReset(); mockDownload.mockReset(); });
afterEach(() => configurePolicies([]));

describe('readDriveContent', () => {
  it('exports a Google Doc as plain text and strips the BOM', async () => {
    metaThenCopy('application/vnd.google-apps.document', 'Notes');
    downloadsText('﻿Hello doc');
    const r = await readDriveContent('me@test.com', 'f1', 50_000);
    expect(mockDownload).toHaveBeenCalledWith('drive', 'files.export',
      { fileId: 'f1', mimeType: 'text/plain' }, expect.any(String), expect.anything());
    expect(r).toMatchObject({ text: 'Hello doc', via: 'export', truncated: false });
  });

  it('converts a PDF through a temporary copy in My Drive root, then deletes the copy', async () => {
    metaThenCopy('application/pdf');
    downloadsText('Signed on 1 March');
    const r = await readDriveContent('me@test.com', 'f1', 50_000);

    expect(mockCall).toHaveBeenCalledWith('drive', 'files.copy', expect.objectContaining({
      fileId: 'f1', mimeType: 'application/vnd.google-apps.document', parents: ['root'],
    }), expect.anything());
    expect(mockDownload).toHaveBeenCalledWith('drive', 'files.export',
      { fileId: 'tmp1', mimeType: 'text/plain' }, expect.any(String), expect.anything());
    expect(mockCall).toHaveBeenCalledWith('drive', 'files.delete',
      { fileId: 'tmp1', supportsAllDrives: true }, expect.anything());
    expect(r).toMatchObject({ text: 'Signed on 1 March', via: 'conversion' });
    expect(r.leftover).toBeUndefined();
  });

  it('converts a spreadsheet into a Sheet and exports CSV', async () => {
    metaThenCopy('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Budget.xlsx');
    downloadsText('a,b\n1,2');
    await readDriveContent('me@test.com', 'f1', 50_000);
    expect(mockCall).toHaveBeenCalledWith('drive', 'files.copy',
      expect.objectContaining({ mimeType: 'application/vnd.google-apps.spreadsheet' }), expect.anything());
    expect(mockDownload).toHaveBeenCalledWith('drive', 'files.export',
      { fileId: 'tmp1', mimeType: 'text/csv' }, expect.any(String), expect.anything());
  });

  it('deletes the copy even when the export fails', async () => {
    metaThenCopy('application/pdf');
    mockDownload.mockRejectedValue(new Error('export broke'));
    await expect(readDriveContent('me@test.com', 'f1', 50_000)).rejects.toThrow('export broke');
    expect(mockCall).toHaveBeenCalledWith('drive', 'files.delete', expect.objectContaining({ fileId: 'tmp1' }), expect.anything());
  });

  it('reports a copy it could not delete instead of hiding it', async () => {
    metaThenCopy('application/pdf');
    const base = mockCall.getMockImplementation()!;
    mockCall.mockImplementation(async (...args) => {
      if (args[1] === 'files.delete') throw new Error('nope');
      return base(...args);
    });
    downloadsText('x');
    const r = await readDriveContent('me@test.com', 'f1', 50_000);
    expect(r.leftover).toBe('tmp1');
  });

  it('downloads plain-text files as stored and truncates long text', async () => {
    metaThenCopy('text/markdown', 'README.md');
    downloadsText('abcdefghij');
    const r = await readDriveContent('me@test.com', 'f1', 4);
    expect(mockCall).not.toHaveBeenCalledWith('drive', 'files.copy', expect.anything(), expect.anything());
    expect(r).toMatchObject({ text: 'abcd', truncated: true, totalChars: 10, via: 'download' });
  });

  it('refuses a type with no text, and conversion when not allowed', async () => {
    metaThenCopy('application/zip', 'a.zip');
    await expect(readDriveContent('me@test.com', 'f1', 50_000)).rejects.toThrow(/no text to read/);

    metaThenCopy('application/pdf');
    await expect(readDriveContent('me@test.com', 'f1', 50_000, false)).rejects.toThrow(/read-only/);
    expect(mockCall).not.toHaveBeenCalledWith('drive', 'files.copy', expect.anything(), expect.anything());
  });
});

describe('drive read handler', () => {
  it('returns the text with how it was obtained', async () => {
    metaThenCopy('application/pdf');
    downloadsText('Clause 4');
    const res = await drivePatch.customHandlers!.read({ fileId: 'f1' }, 'me@test.com');
    expect(res.text).toContain('Clause 4');
    expect(res.text).toContain('converted to text by Drive');
    expect(res.refs).toMatchObject({ via: 'conversion', truncated: false });
  });

  it('does not make a copy under the read-only policy', async () => {
    configurePolicies([readOnly]);
    metaThenCopy('application/pdf');
    await expect(drivePatch.customHandlers!.read({ fileId: 'f1' }, 'me@test.com')).rejects.toThrow(/read-only/);
    expect(mockCall).not.toHaveBeenCalledWith('drive', 'files.copy', expect.anything(), expect.anything());
  });
});
