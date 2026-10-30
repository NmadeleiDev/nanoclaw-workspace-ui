import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, it, expect } from 'vitest';
import { initTestDb, closeDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import './migration.js';
import { GROUPS_DIR } from '../../config.js';
import { WorkspaceStore } from './store.js';
import { WorkspaceService } from './service.js';
import { WorkspaceDocuments } from './documents.js';
let docs: WorkspaceDocuments, store: WorkspaceStore, service: WorkspaceService, root: string, files: string;
beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(db);
  store = new WorkspaceStore(db);
  const folder = 'viewer-test-' + randomUUID();
  root = path.join(GROUPS_DIR, folder);
  fs.mkdirSync(root, { recursive: true });
  files = fs.mkdtempSync(path.resolve('.cache/document-files-'));
  await db.run(
    'INSERT INTO agent_groups(id,name,folder,created_at) VALUES(?,?,?,?)',
    'viewer',
    'Viewer',
    folder,
    new Date().toISOString(),
  );
  await store.addSession({ id: 'one', agentId: 'viewer' });
  await store.addSession({ id: 'two', agentId: 'viewer' });
  service = new WorkspaceService(store, undefined, files);
  docs = new WorkspaceDocuments(service);

  fs.writeFileSync(path.join(root, 'spec.md'), '# Original');
});
afterEach(async () => {
  await service?.stop();
  await closeDb();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(files, { recursive: true, force: true });
});
it('opens, deduplicates, edits and rejects stale saves without losing disk content', async () => {
  const first = await docs.open('one', { path: '/workspace/agent/spec.md' });
  expect(first).toMatchObject({ kind: 'markdown', editable: true, text: '# Original' });
  expect((await docs.open('one', { path: '/workspace/agent/spec.md' })).id).toBe(first.id);
  expect(await docs.list('one')).toHaveLength(1);
  const saved = await docs.save('one', first.id, '# Edited', first.revision);
  expect(saved.revision).not.toBe(first.revision);
  await expect(docs.save('one', first.id, 'stale', first.revision)).rejects.toThrow('changed');
  expect(fs.readFileSync(path.join(root, 'spec.md'), 'utf8')).toBe('# Edited');
  expect(fs.readdirSync(path.join(files, '.document-revisions'))).toHaveLength(1);
});
it('rejects traversal, protected paths, symlinks and cross-session document IDs', async () => {
  await expect(docs.open('one', { path: '/etc/passwd' })).rejects.toThrow('outside');
  fs.writeFileSync(path.join(root, 'container.json'), 'secret');
  await expect(docs.open('one', { path: '/workspace/agent/container.json' })).rejects.toThrow('Protected');
  fs.symlinkSync(path.join(root, 'spec.md'), path.join(root, 'link.md'));
  await expect(docs.open('one', { path: '/workspace/agent/link.md' })).rejects.toThrow();
  const doc = await docs.open('one', { path: '/workspace/agent/spec.md' });
  await expect(docs.read('two', doc.id)).rejects.toThrow('not found');
});
it('orders agent presentations and deduplicates retried requests', async () => {
  const request = randomUUID();
  const input = { path: '/workspace/agent/spec.md' };
  const first = await docs.present('one', request, 'open', input);
  expect(first).toMatchObject({ status: 'presentation requested' });
  await docs.present('one', request, 'open', input);
  expect(await docs.requests('one')).toHaveLength(1);
  await expect(docs.present('one', randomUUID(), 'close', input)).rejects.toThrow('Unknown');
  expect(await docs.requests('two')).toHaveLength(0);
});
it('keeps attachments read-only and rejects attachments from other chats', async () => {
  fs.mkdirSync(path.join(files, 'one'));
  fs.writeFileSync(path.join(files, 'one', 'fixture'), 'hello');
  await store.db.run(
    'INSERT INTO ws_files(id,session_id,filename,path,mime) VALUES(?,?,?,?,?)',
    'abc',
    'one',
    'note.txt',
    'owned:one/fixture',
    'text/plain',
  );
  const doc = await docs.open('one', { attachmentId: 'abc' });
  expect(doc).toMatchObject({ editable: false, text: 'hello' });
  await expect(docs.open('two', { attachmentId: 'abc' })).rejects.toThrow('another conversation');
  await expect(docs.save('one', doc.id, 'changed', doc.revision)).rejects.toThrow('read-only');
});

it('preserves restricted file modes and reports removed files explicitly', async () => {
  fs.chmodSync(path.join(root, 'spec.md'), 0o600);
  const doc = await docs.open('one', { path: 'spec.md' });
  await docs.save('one', doc.id, 'updated', doc.revision);
  expect(fs.statSync(path.join(root, 'spec.md')).mode & 0o777).toBe(0o600);
  fs.unlinkSync(path.join(root, 'spec.md'));
  await expect(docs.read('one', doc.id)).rejects.toThrow('no longer available');
});
it('keeps oversized working files downloadable without reading them into preview memory', async () => {
  const file = path.join(root, 'large.txt');
  const fd = fs.openSync(file, 'w');
  fs.ftruncateSync(fd, 21 * 1024 * 1024);
  fs.closeSync(fd);
  const doc = await docs.open('one', { path: 'large.txt' });
  expect(doc).toMatchObject({ kind: 'unsupported', editable: false, size: 21 * 1024 * 1024 });
  const download = await docs.download('one', doc.id);
  expect(typeof download.fd).toBe('number');
  expect(fs.fstatSync(download.fd!).size).toBe(21 * 1024 * 1024);
  fs.closeSync(download.fd!);
});
