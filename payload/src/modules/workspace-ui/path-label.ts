/** Shorten only the current user's home, never a sibling with the same prefix. */
export function directoryLabel(directory: string, home: string): string {
  const root = home.replace(/\/+$/, '');
  if (!root) return directory;
  if (directory === root || directory === `${root}/`) return '~';
  return directory.startsWith(`${root}/`) ? `~/${directory.slice(root.length + 1)}` : directory;
}
