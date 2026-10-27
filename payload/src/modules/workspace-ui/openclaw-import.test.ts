import fs from 'node:fs';
import path from 'node:path';
import * as zlib from 'node:zlib';
import Database from 'better-sqlite3';
import { beforeEach, afterEach, it, expect } from 'vitest';
import { initTestDb, closeDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import './migration.js';
import { WorkspaceStore } from './store.js';
import { OpenClawImporter } from './openclaw-import.js';

let root: string;
let store: WorkspaceStore;
let importer: OpenClawImporter;
beforeEach(async () => {
  fs.mkdirSync('.cache', { recursive: true });
  root = fs.mkdtempSync(path.resolve('.cache/workspace-import-'));
  fs.mkdirSync(path.join(root, 'state'));
  fs.mkdirSync(path.join(root, 'agents', 'main', 'agent'), { recursive: true });
  const central = new Database(path.join(root, 'state', 'openclaw.sqlite'));
  central.exec('CREATE TABLE session_groups (name TEXT,position INTEGER,cwd TEXT,worktree INTEGER)');
  central.prepare('INSERT INTO session_groups VALUES (?,?,?,?)').run('A project', 0, '/projects/a', 0);
  central.close();
  const source = new Database(path.join(root, 'agents', 'main', 'agent', 'openclaw-agent.sqlite'));
  source.exec(`
    CREATE TABLE session_nodes (session_key TEXT,current_session_id TEXT,entry_json TEXT,category TEXT,display_name TEXT,label TEXT,pinned_at INTEGER,archived_at INTEGER,spawned_by TEXT,created_at INTEGER,updated_at INTEGER,last_activity_at INTEGER);
    CREATE TABLE session_windows (session_key TEXT,session_id TEXT,created_at INTEGER);
    CREATE TABLE transcript_events (session_id TEXT,seq INTEGER,event_json TEXT,event_zstd BLOB,created_at INTEGER);
    CREATE TABLE session_transcript_archives (session_id TEXT,generation TEXT,encoding TEXT,archive_blob BLOB);
    CREATE TABLE session_transcript_cold_archives (session_id TEXT,generation TEXT,storage TEXT,archive_blob BLOB);
  `);
  source
    .prepare('INSERT INTO session_nodes VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(
      'agent:main:one',
      'source-one',
      JSON.stringify({ activitySummary: 'An existing overview.' }),
      'A project',
      'Original first message',
      'Preserve my conversation',
      null,
      null,
      null,
      1793040000000,
      1793040001000,
      1793040001000,
    );
  source.prepare('INSERT INTO session_windows VALUES (?,?,?)').run('agent:main:one', 'source-one', 1793040000000);
  const event = (id: string, role: string, text: string) => ({
    id,
    type: 'message',
    timestamp: '2026-10-27T00:00:00.000Z',
    message: { role, content: [{ type: 'text', text }] },
  });
  source
    .prepare('INSERT INTO transcript_events VALUES (?,?,?,?,?)')
    .run('source-one', 1, JSON.stringify(event('a', 'user', 'Plan a release; do not publish.')), null, 1793040000000);
  const compress = (zlib as unknown as { zstdCompressSync: (b: Buffer) => Buffer }).zstdCompressSync;
  source
    .prepare('INSERT INTO transcript_events VALUES (?,?,?,?,?)')
    .run(
      'source-one',
      2,
      null,
      compress(Buffer.from(JSON.stringify(event('b', 'assistant', 'Prepared the plan. Publishing is still pending.')))),
      1793040001000,
    );
  source
    .prepare('INSERT INTO session_transcript_archives VALUES (?,?,?,?)')
    .run(
      'source-one',
      'old',
      'gzip',
      zlib.gzipSync(Buffer.from(JSON.stringify(event('c', 'toolResult', 'Historical tool output.')))),
    );
  source
    .prepare('INSERT INTO session_transcript_cold_archives VALUES (?,?,?,?)')
    .run(
      'source-one',
      'cold',
      'sqlite',
      compress(Buffer.from(JSON.stringify([event('d', 'user', 'An older correction. Plans are not completed work.')]))),
    );
  source.close();
  const db = await initTestDb();
  await runMigrations(db);
  store = new WorkspaceStore(db);
  await db.run(
    'INSERT INTO agent_groups (id,name,folder,created_at) VALUES (?,?,?,?)',
    'assistant',
    'Assistant',
    'assistant',
    '2026-10-27T00:00:00.000Z',
  );
  importer = new OpenClawImporter(store, path.join(root, 'files'), () => {});
});
afterEach(async () => {
  await importer?.stop();
  await closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

async function complete() {
  const deadline = Date.now() + 5000;
  while (importer.progress.state === 'running' && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(importer.progress.error).toBeUndefined();
  expect(importer.progress.state).toBe('completed');
}

it('imports compressed and archived history idempotently without executing it or changing its source', async () => {
  const sourceFile = path.join(root, 'agents', 'main', 'agent', 'openclaw-agent.sqlite');
  const original = fs.readFileSync(sourceFile);
  const preview = importer.preview(root);
  expect(preview.agents[0]).toMatchObject({ id: 'main', sessions: 1, compressed: 1 });
  importer.start(root, [{ sourceAgentId: 'main', targetAgentId: 'assistant' }]);
  await complete();
  const sessions = await store.sessions();
  expect(sessions).toHaveLength(1);
  expect(sessions[0]).toMatchObject({
    title: 'Preserve my conversation',
    origin: 'openclaw',
    nativeSessionId: null,
    directories: [{ id: expect.any(String), path: '/projects/a', readonly: false }],
  });
  const history = await store.history(sessions[0].id);
  expect(history.messages).toHaveLength(4);
  expect(history.messages.map((m) => m.text)).toContain('Historical tool output.');
  expect((await store.document('session', sessions[0].id)).markdown).toBe('An existing overview.');
  expect(await store.db.all('SELECT id FROM sessions')).toHaveLength(0);
  expect(fs.readFileSync(sourceFile)).toEqual(original);
  importer.start(root, [{ sourceAgentId: 'main', targetAgentId: 'assistant' }]);
  await complete();
  expect(await store.sessions()).toHaveLength(1);
  expect((await store.history(sessions[0].id)).messages).toHaveLength(4);
});

it('rejects directory traversal in source agent identifiers', () => {
  expect(() => importer.start(root, [{ sourceAgentId: '../credentials', targetAgentId: 'assistant' }])).toThrow(
    'Choose the agents',
  );
});
