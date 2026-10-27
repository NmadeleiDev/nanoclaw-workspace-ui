import fs from 'node:fs';
import path from 'node:path';
import { AnchoredDir } from '../../anchored-dir.js';
import { agentSkillRoots, type SkillAgent, type SkillRoot } from './skills.js';

/** Snapshot only instruction files; never copy credentials, provider homes or supporting executables. */
export function snapshotAgentSkills(agents: SkillAgent[], source: string, destination: string): string[] {
  const warnings: string[] = [];
  const roots: SkillRoot[] = [
    { id: 'shared', root: source, segments: ['container', 'skills'] },
    ...agents.flatMap((agent) => agentSkillRoots(agent, source)),
  ];
  const seen = new Set<string>();
  for (const root of roots) {
    const original = path.join(root.root, ...root.segments);
    if (seen.has(original)) continue;
    seen.add(original);
    const relative = path.relative(source, original);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Skill snapshot escaped its source.');
    let dir: AnchoredDir | null = null;
    try {
      dir = AnchoredDir.open(root.root, root.segments);
      if (!dir) continue;
      for (const name of dir.entries()) {
        const stat = dir.lstat(name);
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
        const target = path.join(destination, relative, name);
        fs.mkdirSync(target, { recursive: true, mode: 0o700 });
        let child: AnchoredDir | null = null;
        let fd: number | undefined;
        try {
          child = dir.openDir(name);
          if (!child) continue;
          fd = child.openReadFd('SKILL.md');
          const bytes = Buffer.alloc(1024 * 1024 + 1);
          const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
          // An oversized snapshot remains oversized and visibly unavailable in the catalog.
          fs.writeFileSync(path.join(target, 'SKILL.md'), bytes.subarray(0, count), { mode: 0o600 });
        } catch {
          warnings.push(`Could not snapshot skill: ${name}`);
        } finally {
          if (fd !== undefined) fs.closeSync(fd);
          child?.close();
        }
      }
    } catch {
      warnings.push(`Could not snapshot skill folder: ${root.id}`);
    } finally {
      dir?.close();
    }
  }
  return warnings;
}
