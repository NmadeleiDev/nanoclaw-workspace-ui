import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

/**
 * LOAD-BEARING, both halves. The group directory is mounted read-write at
 * `/workspace/agent`, so the agent can create entries beside the document the
 * host is about to write. A predictable temp name (the old `.tmp-<pid>`, and
 * the host pid is stable for the life of the process) is therefore a path the
 * agent can pre-plant: a symlink there redirects this write to any file the
 * host user can reach, and a directory there fails the spawn on every retry.
 *
 * The random name means there is nothing to pre-plant; `wx` (O_CREAT|O_EXCL)
 * refuses an existing path, symlink included, so a lucky guess fails closed;
 * and the cleanup cannot throw, because a leftover temp file must never be
 * able to dark a group. Mirrors `migrate-claude-memory-settings.ts`, which
 * runs once at startup and so can use pid+time where this needs randomness.
 */
export function writeAtomic(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp-${randomUUID()}`;
  try {
    fs.writeFileSync(tmp, content, { flag: 'wx' });
    fs.renameSync(tmp, filePath);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // The rename consumed the temp file, or creation failed before it existed.
    }
  }
}
