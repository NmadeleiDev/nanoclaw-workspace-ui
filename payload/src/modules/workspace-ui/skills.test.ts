import { registerProviderContainerConfig } from '../../providers/provider-container-registry.js';
import { registerProviderHostContract, getProviderHostContract } from '../../provider-contracts/registry.js';
import '../../provider-contracts/claude.js';
registerProviderContainerConfig('opencode', () => ({}));
registerProviderHostContract('opencode', { ...getProviderHostContract('claude')!, legacyHostAdapter: 'required' });
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { WorkspaceSkills, agentSkillRoots, type SkillAgent } from './skills.js';
import {
  registerGatewayProvider,
  resetGatewayProvider,
  type GatewayProviderDefinition,
} from '../../gateway-providers/index.js';
import { selectedSkillNames } from '../../runtime-skills.js';

let root: string;
let skills: WorkspaceSkills;
const agent: SkillAgent = { id: 'assistant', name: 'Assistant', folder: 'assistant', provider: 'opencode', skills: '["browser"]' };
function write(relative: string, content: string) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}
function skill(relative: string, name: string, description = 'A useful skill.') {
  write(
    `${relative}/SKILL.md`,
    `---\nname: ${name}\ndescription: >-\n  ${description}\n---\n# Instructions\n\nUse **carefully**.`,
  );
}
beforeAll(() => {
  registerGatewayProvider({
    kind: 'skills-inactive-fixture',
    agentSkills: ['inactive-skill'],
    sessions: {
      async ensure() {
        return { contribution: { networkAccess: { endpoint: 'localhost', target: { kind: 'host' } } } };
      },
    },
    approvals: { async subscribe() {} },
  });
});
beforeEach(() => {
  root = fs.mkdtempSync(path.resolve('.cache/workspace-skills-'));
  skills = new WorkspaceSkills(root);
  resetGatewayProvider({
    kind: 'fixture',
    agentSkills: ['required'],
    sessions: {
      async ensure() {
        return { contribution: { networkAccess: { endpoint: 'localhost', target: { kind: 'host' } } } };
      },
    },
    approvals: { async subscribe() {} },
  } satisfies GatewayProviderDefinition);
  skill('container/skills/required', 'Gateway');
  skill('container/skills/browser', 'Browser');
  skill('container/skills/unused', 'Unused');
});
afterEach(() => {
  resetGatewayProvider();
  fs.rmSync(root, { recursive: true, force: true });
});

it('matches runtime selections, includes the required gateway and resolves all dynamically', () => {
  expect(skills.list(agent).skills.map((s) => s.name)).toEqual(['Browser', 'Gateway']);
  expect(selectedSkillNames({ skills: ['browser', 'inactive-skill'] }, path.join(root, 'container/skills'))).toEqual([
    'browser',
    'required',
  ]);
  expect(skills.list({ ...agent, skills: '"all"' }).skills.map((s) => s.name)).toEqual([
    'Browser',
    'Gateway',
    'Unused',
  ]);
  expect(skills.list({ ...agent, skills: '[]' }).skills.map((s) => s.name)).toEqual(['Gateway']);
});

it('includes only this agent’s private skills, honors overrides and ignores runtime links', () => {
  const privateRoot = 'data/v2-sessions/assistant/.claude-shared/skills';
  skill(`${privateRoot}/browser`, 'Custom Browser', 'Private instructions.');
  skill(`${privateRoot}/writer`, 'Writer');
  skill('data/v2-sessions/other/.claude-shared/skills/secret', 'Other Agent');
  fs.symlinkSync('/app/skills/unused', path.join(root, privateRoot, 'unused'));
  const list = skills.list(agent);
  expect(list.skills.map((s) => s.name)).toEqual(['Custom Browser', 'Gateway', 'Writer']);
  expect(list.skills.find((s) => s.name === 'Custom Browser')).toMatchObject({ source: 'agent', available: true });
  expect(list.skills.every((s) => !('markdown' in s))).toBe(true);
  const writer = list.skills.find((s) => s.name === 'Writer')!;
  expect(skills.detail(agent, writer.id).markdown).toContain('Use **carefully**.');
  expect(() => skills.detail({ ...agent, id: 'other', folder: 'other' }, writer.id)).toThrow('Skill not found');
});

it('reports missing files, malformed metadata and oversized files without claiming an empty list', () => {
  write('container/skills/browser/SKILL.md', '---\nname: [broken\n---\n');
  skill('container/skills/large', 'Large');
  write('container/skills/large/SKILL.md', 'x'.repeat(1024 * 1024 + 1));
  const configured = { ...agent, skills: '["browser","missing","large"]' };
  const list = skills.list(configured);
  expect(list.skills.filter((s) => !s.available)).toHaveLength(3);
  expect(list.skills.find((s) => s.name === 'browser')?.error).toContain('invalid YAML');
  expect(list.skills.find((s) => s.name === 'large')?.error).toContain('1 MB');
  const missing = list.skills.find((s) => s.name === 'missing')!;
  expect(() => skills.detail(configured, missing.id)).toThrow('Skill file is missing.');
});

it('rejects traversal, symlinked skill files and symlinked private roots', () => {
  write('secret.md', 'TOP SECRET');
  fs.unlinkSync(path.join(root, 'container/skills/browser/SKILL.md'));
  fs.symlinkSync(path.join(root, 'secret.md'), path.join(root, 'container/skills/browser/SKILL.md'));
  const privateBase = path.join(root, 'data/v2-sessions/assistant');
  fs.mkdirSync(privateBase, { recursive: true });
  fs.symlinkSync(path.join(root, 'container'), path.join(privateBase, '.claude-shared'));
  const list = skills.list({ ...agent, skills: '["browser","../../../secret.md"]' });
  expect(list.warnings).toHaveLength(2);
  expect(list.skills.find((s) => s.name === 'browser')).toMatchObject({ available: false });
  expect(JSON.stringify(list)).not.toContain('TOP SECRET');
  expect(() => agentSkillRoots({ ...agent, folder: '../other' }, root)).toThrow('Invalid agent');
});

it('rereads edited instructions and refuses arbitrary detail identifiers', () => {
  const browser = skills.list(agent).skills.find((s) => s.name === 'Browser')!;
  skill('container/skills/browser', 'Browser', 'Changed description.');
  expect(skills.detail(agent, browser.id).description).toBe('Changed description.');
  expect(() => skills.detail(agent, '../../secret.md')).toThrow('Skill not found');
  expect(() => skills.list({ ...agent, provider: 'uninstalled-provider' })).toThrow('locations are unavailable');
});

it('snapshots only skill instructions and keeps the preview independent of subsequent source edits', async () => {
  const { snapshotAgentSkills } = await import('./skill-snapshot.js');
  const preview = path.join(root, 'preview');
  skill('data/v2-sessions/assistant/.claude-shared/skills/writer', 'Writer');
  write('data/v2-sessions/assistant/.claude-shared/credentials.json', 'SECRET');
  write('container/skills/browser/tool.sh', 'echo not-copied');
  expect(snapshotAgentSkills([agent], root, preview)).toEqual([]);
  expect(fs.existsSync(path.join(preview, 'container/skills/browser/tool.sh'))).toBe(false);
  expect(fs.existsSync(path.join(preview, 'data/v2-sessions/assistant/.claude-shared/credentials.json'))).toBe(false);
  skill('container/skills/browser', 'Changed Browser');
  expect(new WorkspaceSkills(preview).list(agent).skills.map((s) => s.name)).toEqual(['Browser', 'Gateway', 'Writer']);
});

it('discovers provider-declared group directories and staged template overlays without realizing them', async () => {
  const { getProviderHostContract, registerProviderHostContract } = await import('../../provider-contracts/index.js');
  registerProviderHostContract('skill-test', {
    ...getProviderHostContract('claude')!,
    skillBackings: [
      {
        id: 'own-skills',
        location: { kind: 'group-directory', directory: '.agents', subdirectory: '' },
        skillsSubdirectory: 'skills',
        templateCopies: 'copy',
        conflictDiagnostics: 'warn',
      },
    ],
  });
  skill('groups/assistant/.agents/skills/design', 'Design');
  skill('groups/assistant/.agents/skills/template', 'Old Template');
  skill('data/v2-sessions/assistant/.claude-shared/skills/template', 'New Template');
  expect(skills.list({ ...agent, provider: 'skill-test' }).skills.map((s) => s.name)).toEqual([
    'Browser',
    'Design',
    'Gateway',
    'New Template',
  ]);
  expect(fs.readFileSync(path.join(root, 'groups/assistant/.agents/skills/template/SKILL.md'), 'utf8')).toContain(
    'Old Template',
  );
});

it('returns a real empty inventory when neither shared nor private skills are enabled', () => {
  resetGatewayProvider({
    kind: 'empty-fixture',
    agentSkills: [],
    sessions: {
      async ensure() {
        return { contribution: { networkAccess: { endpoint: 'localhost', target: { kind: 'host' } } } };
      },
    },
    approvals: { async subscribe() {} },
  });
  expect(skills.list({ ...agent, skills: '[]' })).toEqual({ skills: [], warnings: [] });
});
