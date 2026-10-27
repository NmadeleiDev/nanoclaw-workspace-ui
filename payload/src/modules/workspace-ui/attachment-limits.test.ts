import { it, expect } from 'vitest';
import { attachmentLimitError, MAX_ATTACHMENT_BYTES } from './attachment-limits.js';
it('enforces file count and combined decoded size at the boundaries', () => {
  const file = { name: 'file', size: 1 };
  expect(attachmentLimitError(Array(10).fill(file))).toBeNull();
  expect(attachmentLimitError(Array(11).fill(file))).toContain('10 files');
  expect(attachmentLimitError([{ ...file, size: MAX_ATTACHMENT_BYTES }])).toBeNull();
  expect(attachmentLimitError([{ ...file, size: MAX_ATTACHMENT_BYTES + 1 }])).toContain('exceeds');
  expect(attachmentLimitError([{ ...file, size: MAX_ATTACHMENT_BYTES }, file])).toContain('total');
  expect(attachmentLimitError([{ ...file, size: NaN }])).not.toBeNull();
});
