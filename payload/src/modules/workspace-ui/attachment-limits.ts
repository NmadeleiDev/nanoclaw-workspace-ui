export const MAX_ATTACHMENT_FILES = 10;
/** Keeps the base64 JSON envelope comfortably below the 32 MiB HTTP limit. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export function attachmentLimitError(files: ReadonlyArray<{ name: string; size: number }>): string | null {
  if (files.length > MAX_ATTACHMENT_FILES) return 'Attach up to 10 files per message.';
  const invalid = files.find(
    (file) => !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_ATTACHMENT_BYTES,
  );
  if (invalid) return `${invalid.name} exceeds the 20 MB attachment limit.`;
  if (files.reduce((total, file) => total + file.size, 0) > MAX_ATTACHMENT_BYTES)
    return 'Attachments must total 20 MB or less per message.';
  return null;
}
