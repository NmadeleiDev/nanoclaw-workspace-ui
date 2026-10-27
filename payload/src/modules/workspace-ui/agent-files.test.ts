import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { AgentFiles, snapshotAgentFiles } from './agent-files.js';

let root: string;
let files: AgentFiles;
const agent = { id: 'one', folder: 'one', provider: 'opencode' };
function write(relative: string, content: string) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}
beforeEach(() => {
  root = fs.mkdtempSync(path.resolve('.cache/workspace-agent-files-'));
  files = new AgentFiles(root);
  write('groups/one/instructions.prepend.md', '# Identity\n\nBe precise.');
  write('groups/one/CLAUDE.md', '# Composed tools');
  write('groups/one/memory/index.md', '# Memory\n\n[People](people/index.md)');
  write('groups/one/memory/people/index.md', '# People');
  write('groups/one/memory/system/definition.md', '# Memory system');
  write('groups/one/memory/openclaw-reference/SOUL.md', '# Original soul');
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

it('lists existing standard files with accurate current, generated and imported labels', () => {
  const list = files.list(agent).files;
  expect(list).toHaveLength(5);
  expect(list.find((file) => file.path === 'instructions.prepend.md')).toMatchObject({
    label: 'Standing instructions',
    source: 'current',
    generated: false,
  });
  expect(list.find((file) => file.path === 'CLAUDE.md')).toMatchObject({
    label: 'Runtime instructions',
    generated: true,
  });
  expect(list.find((file) => file.name === 'SOUL.md')).toMatchObject({
    path: 'memory/openclaw-reference/SOUL.md',
    source: 'imported',
  });
  expect(list.some((file) => file.name === 'TOOLS.md')).toBe(false);
  expect(list.every((file) => !('markdown' in file))).toBe(true);
  write('groups/one/TOOLS.md', '# Reference tools');
  expect(files.list(agent).files.find((file) => file.path === 'TOOLS.md')?.source).toBe('reference');
});

it('reads memory links and fresh content without modifying the files', () => {
  const result = files.read(agent, 'memory/people/index.md');
  expect(result.markdown).toBe('# People');
  expect(result.updatedAt).toMatch(/Z$/);
  write('groups/one/memory/people/index.md', '# Updated people');
  expect(files.read(agent, 'memory/people/index.md').markdown).toBe('# Updated people');
  expect(files.read(agent, 'memory/openclaw-reference/SOUL.md').source).toBe('imported');
});

it('keeps agents isolated and refuses host, traversal, config and non-Markdown paths', () => {
  write('groups/two/instructions.prepend.md', 'Second agent');
  expect(files.read({ ...agent, id: 'two', folder: 'two' }, 'instructions.prepend.md').markdown).toBe('Second agent');
  for (const file of [
    '../two/instructions.prepend.md',
    '/etc/passwd',
    'memory/../../two/instructions.prepend.md',
    'container.json',
    'secrets.md',
    'memory/secret.json',
    'memory\\secret.md',
    'memory/./index.md',
    'memory/secret\0.md',
  ])
    expect(() => files.read(agent, file)).toThrow('Choose an agent instruction');
  expect(() => files.list({ ...agent, folder: '../two' })).toThrow('Invalid agent');
  expect(() => files.read(agent, 'memory/missing.md')).toThrow('Agent file not found');
});

it('refuses symlinked parents and files without disclosing their contents', () => {
  write('secret.md', 'TOP SECRET');
  fs.symlinkSync(path.join(root, 'secret.md'), path.join(root, 'groups/one/SOUL.md'));
  fs.symlinkSync(path.join(root), path.join(root, 'groups/one/memory/escape'));
  const item = files.list(agent).files.find((file) => file.path === 'SOUL.md');
  expect(item).toMatchObject({ available: false, error: 'This file cannot be read safely.' });
  expect(() => files.read(agent, 'SOUL.md')).toThrow('cannot be read safely');
  expect(() => files.read(agent, 'memory/escape/secret.md')).toThrow('cannot be read safely');
  expect(JSON.stringify(files.list(agent))).not.toContain('TOP SECRET');
});

it('handles missing groups, empty and oversized files explicitly', () => {
  expect(files.list({ ...agent, folder: 'absent' }).files).toEqual([]);
  write('groups/one/instructions.prepend.md', '');
  expect(files.read(agent, 'instructions.prepend.md').markdown).toBe('');
  write('groups/one/CLAUDE.md', 'x'.repeat(1024 * 1024 + 1));
  expect(files.list(agent).files.find((file) => file.path === 'CLAUDE.md')).toMatchObject({
    available: false,
    error: 'This file exceeds the 1 MB display limit.',
  });
  expect(() => files.read(agent, 'CLAUDE.md')).toThrow('display limit');
});

it('snapshots viewable Markdown including linked memory, but no config, credentials or symlinks', () => {
  write('groups/one/container.json', 'SECRET CONFIG');
  write('groups/one/memory/credentials.json', 'SECRET TOKEN');
  fs.symlinkSync(path.join(root, 'groups/one/container.json'), path.join(root, 'groups/one/memory/secret.md'));
  const preview = path.join(root, 'preview');
  expect(snapshotAgentFiles([agent], root, preview)).toContain('Skipped linked memory entry: secret.md');
  const copy = new AgentFiles(preview);
  expect(copy.read(agent, 'memory/people/index.md').markdown).toBe('# People');
  expect(copy.read(agent, 'memory/openclaw-reference/SOUL.md').markdown).toBe('# Original soul');
  expect(fs.existsSync(path.join(preview, 'groups/one/container.json'))).toBe(false);
  expect(fs.existsSync(path.join(preview, 'groups/one/memory/credentials.json'))).toBe(false);
  write('groups/one/instructions.prepend.md', '# Changed');
  expect(copy.read(agent, 'instructions.prepend.md').markdown).toContain('Be precise.');
});

it('uses the selected provider’s runtime document without listing it twice as a reference', async () => {
  const { getProviderHostContract, registerProviderHostContract } = await import('../../provider-contracts/index.js');
  const base = getProviderHostContract('claude')!;
  registerProviderHostContract('agent-files-fixture', {
    ...base,
    projectDocument: { ...base.projectDocument, fileName: 'AGENTS.md', containerPath: '/workspace/agent/AGENTS.md' },
  });
  write('groups/one/AGENTS.md', '# Provider instructions');
  const result = files.list({ ...agent, provider: 'agent-files-fixture' }).files;
  expect(result.filter((file) => file.path === 'AGENTS.md')).toHaveLength(1);
  expect(result.find((file) => file.path === 'AGENTS.md')).toMatchObject({ source: 'current', generated: true });
  expect(result.some((file) => file.path === 'CLAUDE.md')).toBe(false);
});
