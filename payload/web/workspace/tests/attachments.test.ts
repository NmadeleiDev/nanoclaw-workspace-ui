import { it, expect } from 'vitest';
import { transferFiles } from '../src/attachments.js';
it('reads images and Finder-style file payloads without treating text as an attachment', () => {
  const image = new File(['png'], 'image.png', { type: 'image/png' });
  expect(transferFiles({ files: [image] }).files).toEqual([image]);
  expect(transferFiles({ files: [], items: [{ kind: 'string', getAsFile: () => null }] })).toEqual({
    files: [],
    folders: false,
  });
  const text = new File(['text'], 'notes.txt', { type: 'text/plain' });
  expect(transferFiles({ files: [image, text] }).files).toEqual([image, text]);
});
it('keeps files from a mixed drop and identifies folders for an explicit warning', () => {
  const file = new File(['body'], 'notes.txt');
  const folder = new File([], 'project');
  const result = transferFiles({
    files: [file, folder],
    items: [
      { kind: 'file', getAsFile: () => folder, webkitGetAsEntry: () => ({ isDirectory: true }) },
      { kind: 'file', getAsFile: () => file, webkitGetAsEntry: () => ({ isDirectory: false }) },
    ],
  });
  expect(result).toEqual({ files: [file], folders: true });
});
