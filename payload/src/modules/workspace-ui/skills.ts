import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { AnchoredDir } from '../../anchored-dir.js';
import { isSafeAttachmentName } from '../../attachment-safety.js';
import { parseSkillSelection } from '../../container-config.js';
import { selectedSkillNames } from '../../runtime-skills.js';
import { getProviderHostContract } from '../../provider-contracts/index.js';
import { resolveProviderName } from '../../providers/provider-name.js';
import { WorkspaceError } from './types.js';

export interface SkillAgent {
  id: string;
  name: string;
  folder: string;
  provider?: string | null;
  skills?: string;
}
export interface SkillRoot {
  id: string;
  root: string;
  segments: string[];
}
export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  source: 'shared' | 'agent';
  available: boolean;
  error?: string;
}
interface SkillEntry extends AgentSkill {
  markdown?: string;
}

/** Group-lifetime provider surfaces only. Reading this inventory never realizes a runtime. */
export function agentSkillRoots(agent: SkillAgent, projectRoot = process.cwd()): SkillRoot[] {
  const contract = getProviderHostContract(resolveProviderName(null, agent.provider));
  if (!contract) throw new WorkspaceError(503, 'This agent’s skill locations are unavailable.');
  if (!isSafeAttachmentName(agent.folder) || !isSafeAttachmentName(agent.id))
    throw new WorkspaceError(400, 'Invalid agent skill location.');
  const roots: SkillRoot[] = [];
  for (const backing of contract.skillBackings) {
    const location = backing.location;
    let root: string;
    let relative: string;
    if (location.kind === 'group-directory') {
      root = path.join(projectRoot, 'groups', agent.folder);
      relative = path.join(location.directory, location.subdirectory, backing.skillsSubdirectory);
    } else {
      const volume = contract.stateVolumes.find((v) => v.id === location.volumeId);
      if (!volume || volume.scope !== 'group') continue;
      root = path.join(projectRoot, 'data/v2-sessions', agent.id);
      relative = path.join(volume.directory, location.subdirectory, backing.skillsSubdirectory);
    }
    const segments = relative.split(path.sep);
    if (!segments.every(isSafeAttachmentName)) throw new WorkspaceError(400, 'Invalid agent skill location.');
    roots.push({ id: backing.id, root, segments });
    // Template materialization overwrites the provider copy at spawn, so its source wins.
    if (backing.templateCopies === 'copy')
      roots.push({
        id: backing.id,
        root: path.join(projectRoot, 'data/v2-sessions', agent.id),
        segments: ['.claude-shared', 'skills'],
      });
  }
  return roots;
}

const skillId = (source: string, name: string) => createHash('sha256').update(`${source}\0${name}`).digest('hex');
const MAX_SKILL_BYTES = 1024 * 1024;

function readSkill(dir: AnchoredDir, name: string, source: AgentSkill['source'], identity: string): SkillEntry {
  const item: SkillEntry = { id: skillId(identity, name), name, description: '', source, available: false };
  let child: AnchoredDir | null = null;
  let fd: number | undefined;
  try {
    child = dir.openDir(name);
    if (!child) throw new Error('Skill file is missing.');
    fd = child.openReadFd('SKILL.md');
    if (fs.fstatSync(fd).size > MAX_SKILL_BYTES) throw new Error('Skill file exceeds the 1 MB display limit.');
    // Bound reads even if the agent grows the file concurrently.
    const bytes = Buffer.alloc(MAX_SKILL_BYTES + 1);
    const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (count > MAX_SKILL_BYTES) throw new Error('Skill file exceeds the 1 MB display limit.');
    const text = bytes
      .subarray(0, count)
      .toString('utf8')
      .replace(/^\uFEFF/, '');
    const lines = text.split(/\r?\n/);
    const end = lines.indexOf('---', 1);
    if (lines[0] !== '---' || end < 0) throw new Error('Skill metadata is missing.');
    let metadata: unknown;
    try {
      metadata = parse(lines.slice(1, end).join('\n'));
    } catch {
      throw new Error('Skill metadata contains invalid YAML.');
    }
    const m = metadata as { name?: unknown; description?: unknown } | null;
    if (
      !m ||
      typeof m.name !== 'string' ||
      !m.name.trim() ||
      typeof m.description !== 'string' ||
      !m.description.trim()
    )
      throw new Error('Skill metadata needs a name and description.');
    return {
      ...item,
      name: m.name.trim(),
      description: m.description.trim(),
      available: true,
      markdown: lines
        .slice(end + 1)
        .join('\n')
        .trim(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    item.error = message.startsWith('Skill ') ? message : 'Skill instructions cannot be read safely.';
    return item;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    child?.close();
  }
}

export class WorkspaceSkills {
  constructor(readonly projectRoot = process.cwd()) {}

  private inventory(agent: SkillAgent): { entries: SkillEntry[]; warnings: string[] } {
    const sharedRoot = path.join(this.projectRoot, 'container/skills');
    const selected = selectedSkillNames({ skills: parseSkillSelection(agent.skills, agent.name) }, sharedRoot);
    const warnings: string[] = [];
    // One effective entry per directory name; agent entries shadow shared symlinks.
    const entries = new Map<string, SkillEntry>();
    let shared: AnchoredDir | null = null;
    try {
      shared = AnchoredDir.open(this.projectRoot, ['container', 'skills']);
      for (const name of selected) {
        if (!isSafeAttachmentName(name)) {
          warnings.push('An invalid configured skill name was refused.');
          continue;
        }
        entries.set(
          name,
          shared
            ? readSkill(shared, name, 'shared', 'shared')
            : {
                id: skillId('shared', name),
                name,
                description: '',
                source: 'shared',
                available: false,
                error: 'Skill file is missing.',
              },
        );
      }
    } catch {
      throw new WorkspaceError(503, 'Shared skills cannot be read safely.');
    } finally {
      shared?.close();
    }
    for (const root of agentSkillRoots(agent, this.projectRoot)) {
      let dir: AnchoredDir | null = null;
      try {
        dir = AnchoredDir.open(root.root, root.segments);
        if (!dir) continue;
        for (const name of dir.entries()) {
          const stat = dir.lstat(name);
          // Runtime-managed symlinks are resolved from selection above, never followed here.
          if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
          entries.set(name, readSkill(dir, name, 'agent', root.id));
        }
      } catch {
        warnings.push('An agent skill folder could not be read safely.');
      } finally {
        dir?.close();
      }
    }
    return {
      entries: [...entries.values()].sort((a, b) => a.name.localeCompare(b.name)),
      warnings: [...new Set(warnings)],
    };
  }

  list(agent: SkillAgent) {
    const { entries, warnings } = this.inventory(agent);
    return { skills: entries.map(({ markdown: _markdown, ...metadata }) => metadata), warnings };
  }

  detail(agent: SkillAgent, id: string) {
    const item = this.inventory(agent).entries.find((entry) => entry.id === id);
    if (!item) throw new WorkspaceError(404, 'Skill not found for this agent.');
    if (!item.available) throw new WorkspaceError(409, item.error || 'Skill unavailable.');
    return item;
  }
}
