import { useEffect, useRef, useState } from 'react';
import { attachmentLimitError } from '../../../src/modules/workspace-ui/attachment-limits.js';
export type DraftAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  data: string | null;
  preview?: string;
};
const previewable = /^image\/(png|jpe?g|gif|webp|avif|bmp)$/i;
export function fileSize(size: number) {
  return size < 1024
    ? `${size} B`
    : size < 1024 * 1024
      ? `${Math.ceil(size / 1024)} KB`
      : `${(size / 1024 / 1024).toFixed(1)} MB`;
}
export function transferFiles(transfer: {
  files: ArrayLike<File>;
  items?: ArrayLike<{
    kind: string;
    getAsFile: () => File | null;
    webkitGetAsEntry?: () => { isDirectory: boolean } | null;
  }>;
}) {
  const items = Array.from(transfer.items ?? []);
  const folders = items.some((item) => item.webkitGetAsEntry?.()?.isDirectory);
  const files = folders
    ? items
        .filter((item) => item.kind === 'file' && !item.webkitGetAsEntry?.()?.isDirectory)
        .map((item) => item.getAsFile())
        .filter((file): file is File => !!file)
    : Array.from(transfer.files);
  return { files, folders };
}

export function useChatAttachments(scope: string | null, notify: (message: string) => void) {
  const [files, setFiles] = useState<DraftAttachment[]>([]);
  const current = useRef({
    scope,
    active: true,
    files: [] as DraftAttachment[],
    readers: new Map<string, FileReader>(),
  });
  useEffect(() => {
    const previous = current.current;
    previous.active = false;
    for (const reader of previous.readers.values()) reader.abort();
    for (const file of previous.files) if (file.preview) URL.revokeObjectURL(file.preview);
    const state = { scope, active: true, files: [] as DraftAttachment[], readers: new Map<string, FileReader>() };
    current.current = state;
    setFiles([]);
    return () => {
      state.active = false;
      for (const reader of state.readers.values()) reader.abort();
      for (const file of state.files) if (file.preview) URL.revokeObjectURL(file.preview);
    };
  }, [scope]);
  const remove = (id: string) => {
    const state = current.current;
    if (!state.active || state.scope !== scope) return;
    const file = state.files.find((f) => f.id === id);
    if (file?.preview) URL.revokeObjectURL(file.preview);
    state.files = state.files.filter((f) => f.id !== id);
    state.readers.get(id)?.abort();
    setFiles([...state.files]);
  };
  const clear = () => {
    const state = current.current;
    if (!state.active || state.scope !== scope) return;
    for (const file of state.files) if (file.preview) URL.revokeObjectURL(file.preview);
    state.files = [];
    for (const reader of state.readers.values()) reader.abort();
    setFiles([]);
  };
  const add = async (incoming: FileList | File[]) => {
    const state = current.current;
    if (!state.active || state.scope !== scope) return;
    const sources = Array.from(incoming);
    if (!sources.length) return;
    const error = attachmentLimitError([...state.files, ...sources]);
    if (error) {
      notify(error);
      return;
    }
    // Reserve synchronously, so consecutive paste/drop events cannot exceed limits.
    const reserved = sources.map(
      (file) =>
        ({
          id: crypto.randomUUID(),
          name: file.name || 'Pasted image.png',
          mimeType: file.type || 'application/octet-stream',
          size: file.size,
          data: null,
          preview: previewable.test(file.type) ? URL.createObjectURL(file) : undefined,
        }) satisfies DraftAttachment,
    );
    state.files.push(...reserved);
    setFiles([...state.files]);
    await Promise.all(
      sources.map(async (file, index) => {
        const id = reserved[index].id;
        try {
          const data = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            state.readers.set(id, reader);
            reader.onload = () => {
              const result = String(reader.result);
              resolve(result.slice(result.indexOf(',') + 1));
            };
            reader.onerror = () => reject(reader.error);
            reader.onabort = () => reject(new DOMException('Cancelled', 'AbortError'));
            reader.readAsDataURL(file);
          });
          if (!state.active || current.current !== state || !state.files.some((f) => f.id === id)) return;
          state.files = state.files.map((f) => (f.id === id ? { ...f, data } : f));
          setFiles([...state.files]);
        } catch {
          if (state.active && current.current === state && state.files.some((f) => f.id === id)) {
            remove(id);
            notify(`Could not read ${file.name}. Try attaching it again.`);
          }
        } finally {
          state.readers.delete(id);
        }
      }),
    );
  };
  return { files, add, remove, clear, reading: files.some((f) => f.data === null) };
}
