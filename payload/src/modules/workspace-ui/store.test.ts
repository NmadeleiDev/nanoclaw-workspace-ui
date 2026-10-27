import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { initTestDb, closeDb } from '../../db/connection.js';
import './migration.js';
import { runMigrations } from '../../db/migrations/index.js';
import { WorkspaceStore } from './store.js';
import { THEME_PRESETS } from './appearance.js';

let store: WorkspaceStore;
beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(db);
  store = new WorkspaceStore(db);
  const timestamp = '2026-10-27T00:00:00.000Z';
  for (const id of ['assistant', 'engineer'])
    await db.run('INSERT INTO agent_groups (id,name,folder,created_at) VALUES (?,?,?,?)', id, id, id, timestamp);
});
afterEach(closeDb);

it('adds appearance defaults to legacy settings while retaining the saved mode and utility profile', async () => {
  const { themePreset: _preset, ambientMotion: _motion, ...legacy } = await store.settings();
  await store.db.run('INSERT INTO ws_settings (id,value) VALUES (?,?)', 'workspace', JSON.stringify({ ...legacy, theme: 'light' }));
  expect(await store.settings()).toMatchObject({ theme: 'light', themePreset: 'cosmic-night', ambientMotion: true, utility: legacy.utility });
});

it('persists every preset and partial appearance updates without changing other settings', async () => {
  const initial = await store.settings();
  for (const themePreset of THEME_PRESETS) {
    await store.saveSettings({ themePreset });
    expect(await store.settings()).toMatchObject({ themePreset, theme: initial.theme, utility: initial.utility });
  }
  await store.saveSettings({ ambientMotion: false, theme: 'system' });
  expect(await store.settings()).toMatchObject({ themePreset: 'classic', ambientMotion: false, theme: 'system' });
});

it('rejects invalid appearance values atomically', async () => {
  const initial = await store.settings();
  for (const input of [{ themePreset: 'unknown' }, { themePreset: null }, { ambientMotion: 'false' }, { ambientMotion: null }]) {
    await expect(store.saveSettings(input as never)).rejects.toMatchObject({ status: 400 });
    expect(await store.settings()).toEqual(initial);
  }
});

describe('workspace ownership and context metadata', () => {
  it('shares a project between agents while snapshotting directories per session', async () => {
    const folder = { id: 'repo', path: '/projects/one', readonly: false };
    const project = await store.saveProject({ name: 'One', description: 'Build it carefully.', directories: [folder] });
    const first = await store.addSession({ id: 'one', agentId: 'assistant', projectId: project.id });
    await store.addSession({ id: 'two', agentId: 'engineer', projectId: project.id });
    await store.saveProject({ ...project, directories: [{ ...folder, path: '/projects/two' }] });
    const third = await store.addSession({ id: 'three', agentId: 'assistant', projectId: project.id });
    expect(first.directories[0].path).toBe('/projects/one');
    expect((await store.getSession('two')).directories[0].path).toBe('/projects/one');
    expect(third.directories[0].path).toBe('/projects/two');
    await store.updateSession('one', { directories: [], primaryDirectoryId: null });
    expect((await store.getSession('one')).directories).toEqual([]);
    expect((await store.getSession('two')).projectId).toBe(project.id);
  });

  it('rejects inconsistent working directories and malformed profiles', async () => {
    await expect(store.addSession({ id: 'bad', agentId: 'assistant', primaryDirectoryId: 'missing' })).rejects.toThrow(
      'attached',
    );
    await expect(
      store.saveSettings({ utility: { provider: 'ollama', model: 'qwen', endpoint: 'https://attacker.example' } }),
    ).rejects.toThrow('local');
    await expect(
      store.saveSettings({
        utility: { provider: 'ollama', model: 'qwen', endpoint: 'http://user:password@localhost:11434' },
      }),
    ).rejects.toThrow('local');
  });

  it('keeps human titles authoritative under delayed automatic updates', async () => {
    await store.addSession({ id: 'one', agentId: 'assistant' });
    await store.updateSession('one', { title: 'My title' });
    await store.updateSession('one', { title: 'Generated later' }, true);
    expect((await store.getSession('one')).title).toBe('My title');
    expect((await store.getSession('one')).customTitle).toBe(true);
  });

  it('retains revisions and refuses an obsolete background write', async () => {
    await store.addSession({ id: 'one', agentId: 'assistant' });
    await store.saveDocument('session', 'one', 'Plan A', 0, 'utility:ollama');
    await store.saveDocument('session', 'one', 'Human correction: Plan B', 1, 'human:owner');
    await expect(store.saveDocument('session', 'one', 'Obsolete summary', 1, 'utility:ollama')).rejects.toMatchObject({
      status: 409,
    });
    expect((await store.document('session', 'one')).markdown).toBe('Human correction: Plan B');
    const revisions = await store.revisions('session', 'one');
    expect(revisions.map((r) => r.markdown)).toEqual(['Human correction: Plan B', 'Plan A']);
    await store.saveDocument('session', 'one', revisions[1].markdown, 2, 'human:owner');
    expect((await store.document('session', 'one')).revision).toBe(3);
  });

  it('paginates equal timestamps without duplicates and treats SQL wildcard input literally', async () => {
    await store.addSession({ id: 'one', agentId: 'assistant' });
    for (let i = 0; i < 7; i++)
      await store.putMessage({
        id: `msg-${i}`,
        sessionId: 'one',
        role: 'user',
        kind: 'chat',
        text: i === 3 ? '100% done' : 'Other',
        timestamp: '2026-10-27T00:00:00.000Z',
        source: 'web',
        files: [],
      });
    const first = await store.history('one', undefined, 3);
    const second = await store.history('one', first.next!, 3);
    const third = await store.history('one', second.next!, 3);
    expect(new Set([...first.messages, ...second.messages, ...third.messages].map((m) => m.id)).size).toBe(7);
    expect(await store.search('%')).toHaveLength(1);
    expect(await store.search("' OR 1=1 --")).toHaveLength(0);
    expect(await store.putMessage(first.messages[0])).toBe(false);
  });
});

it('persists an accessible text scale without changing chat or utility model configuration', async () => {
  expect((await store.settings()).textScale).toBe(100);
  const initial = await store.settings();
  const saved = await store.saveSettings({ textScale: 140 });
  expect(saved.textScale).toBe(140);
  expect(saved.utility).toEqual(initial.utility);
  expect((await store.settings()).textScale).toBe(140);
  await expect(store.saveSettings({ textScale: 99 })).rejects.toMatchObject({ status: 400 });
  await expect(store.saveSettings({ textScale: 201 })).rejects.toMatchObject({ status: 400 });
});
