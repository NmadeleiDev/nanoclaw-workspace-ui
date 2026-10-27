import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MOUNT_ALLOWLIST_PATH } from '../../config.js';
import { inspectMountCandidate, validateMount } from '../mount-security/index.js';
import { WorkspaceError, parseDirectories, type DirectoryAttachment } from './types.js';

export function inspectDirectories(input: unknown) {
  return parseDirectories(input).map((directory) => {
    try {
      const candidate = inspectMountCandidate(directory.path);
      const validation = validateMount({
        hostPath: candidate.realPath,
        containerPath: directory.id,
        readonly: directory.readonly,
      });
      const allowed = validation.allowed && validation.effectiveReadonly === directory.readonly;
      return {
        ...directory,
        path: candidate.realPath,
        allowed,
        grantable: !candidate.blocked,
        reason: candidate.blocked
          ? `Protected path: ${candidate.blocked}`
          : allowed
            ? validation.reason
            : validation.allowed
              ? 'This folder currently permits read-only access.'
              : validation.reason,
      };
    } catch (error) {
      return {
        ...directory,
        allowed: false,
        grantable: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

export function requireDirectories(directories: DirectoryAttachment[]): DirectoryAttachment[] {
  const inspected = inspectDirectories(directories);
  const rejected = inspected.find((d) => !d.allowed);
  if (rejected)
    throw new WorkspaceError(
      403,
      `${rejected.path}: ${rejected.reason}. Review folder access before starting this session.`,
    );
  return inspected.map(({ id, path: directory, readonly }) => ({ id, path: directory, readonly }));
}

/** Called only after a paired operator explicitly confirms this exact list. */
export function grantDirectories(input: unknown): void {
  const inspected = inspectDirectories(input);
  if (inspected.some((d) => !d.grantable))
    throw new WorkspaceError(403, 'A selected path is protected or unavailable.');
  let config: { allowedRoots: Array<Record<string, unknown>>; blockedPatterns: string[] };
  if (fs.existsSync(MOUNT_ALLOWLIST_PATH)) {
    config = JSON.parse(fs.readFileSync(MOUNT_ALLOWLIST_PATH, 'utf8'));
    if (!Array.isArray(config.allowedRoots) || !Array.isArray(config.blockedPatterns))
      throw new WorkspaceError(409, 'The existing mount allowlist needs repair; it has not been changed.');
  } else config = { allowedRoots: [], blockedPatterns: [] };
  for (const d of inspected) {
    if (d.allowed) continue;
    const existing = config.allowedRoots.find((root) => root.path === d.path);
    if (existing) existing.allowReadWrite = !d.readonly || existing.allowReadWrite === true;
    else
      config.allowedRoots.push({
        path: d.path,
        allowReadWrite: !d.readonly,
        description: 'Explicitly granted in NanoClaw Workspace',
      });
  }
  fs.mkdirSync(path.dirname(MOUNT_ALLOWLIST_PATH), { recursive: true, mode: 0o700 });
  const temporary = `${MOUNT_ALLOWLIST_PATH}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, MOUNT_ALLOWLIST_PATH);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function browseDirectories(requested: string) {
  const candidate = inspectMountCandidate(requested);
  if (candidate.blocked) throw new WorkspaceError(403, 'This directory is protected.');
  const entries = fs
    .readdirSync(candidate.realPath, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.') && entry.isDirectory())
    .slice(0, 500)
    .map((entry) => ({ name: entry.name, path: path.join(candidate.realPath, entry.name) }));
  return {
    path: candidate.realPath,
    parent: path.dirname(candidate.realPath),
    entries: entries.sort((a, b) => a.name.localeCompare(b.name)),
  };
}
