import fs from 'node:fs';
import path from 'node:path';
import { AnchoredDir } from '../../anchored-dir.js';
import { isSafeAttachmentName } from '../../attachment-safety.js';
import { PERSONA_PREPEND_FILE } from '../../group-persona.js';
import { getProviderHostContract } from '../../provider-contracts/index.js';
import { resolveProviderName } from '../../providers/provider-name.js';
import { WorkspaceError } from './types.js';

export interface AgentFile {
  path: string;
  name: string;
  label: string;
  source: 'current' | 'reference' | 'imported';
  generated: boolean;
  available: boolean;
  updatedAt?: string;
  error?: string;
}
const STANDARD_FILES = [
  'SOUL.md',
  'IDENTITY.md',
  'USER.md',
  'TOOLS.md',
  'MEMORY.md',
  'AGENTS.md',
  'ROLE.md',
  'CREDO.md',
];
const MAX_FILE_BYTES = 1024 * 1024;
interface FileAgent {
  id: string;
  folder: string;
  provider?: string | null;
}

function definitions(agent: FileAgent): AgentFile[] {
  const runtimeFile =
    getProviderHostContract(resolveProviderName(null, agent.provider))?.projectDocument.fileName ?? 'CLAUDE.md';
  const entry = (
    file: string,
    label: string,
    source: AgentFile['source'] = 'current',
    generated = false,
  ): AgentFile => ({ path: file, name: path.posix.basename(file), label, source, generated, available: true });
  const current = [
    entry(PERSONA_PREPEND_FILE, 'Standing instructions'),
    entry('memory/index.md', 'Memory'),
    entry('memory/system/definition.md', 'Memory system'),
    entry('memory/system/index.md', 'Memory guide'),
    entry(runtimeFile, 'Runtime instructions', 'current', true),
  ];
  return [
    ...current,
    ...STANDARD_FILES.filter((file) => !current.some((item) => item.path === file)).map((file) =>
      entry(file, file, 'reference'),
    ),
    ...STANDARD_FILES.map((file) => entry(`memory/openclaw-reference/${file}`, file, 'imported')),
  ];
}
function segmentsFor(agent: FileAgent, file: string): string[] {
  const segments = file.split('/');
  if (
    !isSafeAttachmentName(agent.folder) ||
    !isSafeAttachmentName(agent.id) ||
    !segments.every(isSafeAttachmentName) ||
    file.length > 4096 ||
    !file.endsWith('.md') ||
    !(definitions(agent).some((item) => item.path === file) || (segments[0] === 'memory' && segments.length > 1))
  )
    throw new WorkspaceError(400, 'Choose an agent instruction or memory Markdown file.');
  return segments;
}
function groupRoot(agent: FileAgent, root: string): string {
  if (!isSafeAttachmentName(agent.folder) || !isSafeAttachmentName(agent.id))
    throw new WorkspaceError(400, 'Invalid agent file location.');
  return path.join(root, 'groups', agent.folder);
}
function readBounded(fd: number): Buffer {
  const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
  let count = 0;
  while (count < bytes.length) {
    const read = fs.readSync(fd, bytes, count, bytes.length - count, count);
    if (!read) break;
    count += read;
  }
  return bytes.subarray(0, count);
}

export class AgentFiles {
  constructor(readonly projectRoot = process.cwd()) {}

  private inspect(agent: FileAgent, file: string, read: boolean): { updatedAt: string; markdown?: string } {
    const segments = segmentsFor(agent, file);
    let dir: AnchoredDir | null = null;
    let fd: number | undefined;
    try {
      dir = AnchoredDir.open(groupRoot(agent, this.projectRoot), segments.slice(0, -1));
      if (!dir) throw new WorkspaceError(404, 'Agent file not found.');
      fd = dir.openReadFd(segments[segments.length - 1]);
      const stat = fs.fstatSync(fd);
      if (stat.size > MAX_FILE_BYTES) throw new WorkspaceError(413, 'This file exceeds the 1 MB display limit.');
      const result: { updatedAt: string; markdown?: string } = { updatedAt: stat.mtime.toISOString() };
      if (read) {
        const bytes = readBounded(fd);
        if (bytes.length > MAX_FILE_BYTES) throw new WorkspaceError(413, 'This file exceeds the 1 MB display limit.');
        result.markdown = bytes.toString('utf8');
      }
      return result;
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new WorkspaceError(404, 'Agent file not found.');
      throw new WorkspaceError(409, 'This file cannot be read safely.');
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      dir?.close();
    }
  }

  list(agent: FileAgent): { files: AgentFile[] } {
    groupRoot(agent, this.projectRoot);
    const files: AgentFile[] = [];
    for (const item of definitions(agent)) {
      try {
        files.push({ ...item, ...this.inspect(agent, item.path, false) });
      } catch (error) {
        if (error instanceof WorkspaceError && error.status === 404) continue;
        if (!(error instanceof WorkspaceError)) throw error;
        files.push({ ...item, available: false, error: error.message });
      }
    }
    return { files };
  }

  read(agent: FileAgent, file: string) {
    const metadata = definitions(agent).find((item) => item.path === file) ?? {
      path: file,
      name: path.posix.basename(file),
      label: path.posix.basename(file),
      source: file.startsWith('memory/openclaw-reference/') ? ('imported' as const) : ('current' as const),
      generated: false,
      available: true,
    };
    return { ...metadata, ...this.inspect(agent, file, true) };
  }
}

/** Copy only viewable Markdown into an isolated preview, using descriptor-anchored reads. */
export function snapshotAgentFiles(agents: FileAgent[], source: string, destination: string): string[] {
  const warnings: string[] = [];
  for (const agent of agents) {
    const origin = groupRoot(agent, source);
    const target = groupRoot(agent, destination);
    let dir: AnchoredDir | null = null;
    const copyFile = (parent: AnchoredDir, name: string, dest: string) => {
      let fd: number | undefined;
      try {
        fd = parent.openReadFd(name);
        const stat = fs.fstatSync(fd);
        const bytes = readBounded(fd);
        fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
        fs.writeFileSync(dest, bytes, { mode: 0o600 });
        fs.utimesSync(dest, stat.atime, stat.mtime);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          warnings.push(`Could not snapshot agent file: ${agent.folder}/${name}`);
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
    };
    const copyMemory = (parent: AnchoredDir, dest: string, depth: number) => {
      if (depth > 64) {
        warnings.push('Memory snapshot exceeds the directory depth limit.');
        return;
      }
      for (const name of parent.entries()) {
        const stat = parent.lstat(name);
        if (stat.isSymbolicLink()) {
          warnings.push(`Skipped linked memory entry: ${name}`);
          continue;
        }
        if (stat.isDirectory()) {
          const child = parent.openDir(name);
          if (child)
            try {
              copyMemory(child, path.join(dest, name), depth + 1);
            } finally {
              child.close();
            }
        } else if (stat.isFile() && name.endsWith('.md')) copyFile(parent, name, path.join(dest, name));
      }
    };
    try {
      dir = AnchoredDir.open(origin, []);
      if (!dir) continue;
      for (const item of definitions(agent).filter((item) => !item.path.includes('/')))
        copyFile(dir, item.path, path.join(target, item.path));
      const memory = dir.openDir('memory');
      if (memory)
        try {
          copyMemory(memory, path.join(target, 'memory'), 0);
        } finally {
          memory.close();
        }
    } catch {
      warnings.push(`Could not snapshot agent files: ${agent.folder}`);
    } finally {
      dir?.close();
    }
  }
  return [...new Set(warnings)];
}
