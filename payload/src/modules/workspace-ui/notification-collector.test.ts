import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { initTestDb, closeDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import './migration.js';
import { WorkspaceStore } from './store.js';
import { WorkspaceService } from './service.js';
import type { WorkspaceMailboxMessage, WorkspaceMailboxEvent } from '../../mailbox/types.js';
const fake = vi.hoisted(() => ({
  out: [] as WorkspaceMailboxMessage[],
  events: [] as WorkspaceMailboxEvent[],
  limit: 200,
}));
vi.mock('../../session-manager.js', async () => ({
  ...(await vi.importActual('../../session-manager.js')),
  withExistingMailboxSession: async (_a: string, _s: string, fn: (box: any) => unknown) =>
    fn({
      getWorkspaceInbound: () => [],
      getWorkspaceOutbound: (after: number) => fake.out.filter((r) => r.seq > after).slice(0, fake.limit),
      getWorkspaceEvents: (after: number) => fake.events.filter((r) => r.seq > after),
    }),
}));
let store: WorkspaceStore;
let service: WorkspaceService;
beforeEach(async () => {
  fake.out = [];
  fake.events = [];
  fake.limit = 200;
  const db = await initTestDb();
  await runMigrations(db);
  store = new WorkspaceStore(db);
  service = new WorkspaceService(store);
  await db.run('UPDATE ws_settings SET value=? WHERE id=?', '2000-01-01T00:00:00.000Z', 'notification-baseline');
  await db.run(
    'INSERT INTO agent_groups (id,name,folder,created_at) VALUES (?,?,?,?)',
    'agent',
    'Agent',
    'agent',
    new Date().toISOString(),
  );
  await db.run(
    'INSERT INTO sessions (id,agent_group_id,thread_id,status,container_status,created_at) VALUES (?,?,?,?,?,?)',
    's',
    'agent',
    'system:workspace:s',
    'active',
    'stopped',
    new Date().toISOString(),
  );
  await store.addSession({ id: 's', nativeSessionId: 's', agentId: 'agent' });
  await service.notifications.start();
});
afterEach(async () => {
  await service.stop();
  await closeDb();
});
const message = (id: string, seq: number, text: string): WorkspaceMailboxMessage => ({
  id,
  seq,
  timestamp: new Date().toISOString(),
  kind: 'chat',
  content: JSON.stringify({ text }),
  channel_type: 'workspace',
});
const terminal = (seq: number, id: string, ranges: unknown[], failed = false): WorkspaceMailboxEvent => ({
  seq,
  timestamp: new Date().toISOString(),
  kind: 'turn-finished',
  content: JSON.stringify({ id, ranges, failed }),
});
it('waits for all referenced outbound rows before checkpointing, then records exactly one activity', async () => {
  fake.limit = 1;
  fake.out = [message('a', 1, 'First'), message('b', 3, 'Second')];
  fake.events = [terminal(1, 'turn', [{ after: 0, upto: 3 }])];
  const session = await store.getSession('s');
  await service.collect(session);
  expect(await store.db.all('SELECT id FROM ws_activity')).toHaveLength(0);
  await service.collect(session);
  await service.collect(session);
  const rows = await store.db.all<{ text: string; message_id: string }>('SELECT text,message_id FROM ws_activity');
  expect(rows).toHaveLength(1);
  expect(rows[0]).toEqual({ text: 'First Second', message_id: 's:out:b' });
});
it('combines only its logical turn ranges, excluding an interleaved follow-up and external destinations', async () => {
  fake.out = [
    message('a', 1, 'Original'),
    message('other', 3, 'Other turn'),
    message('retry', 5, 'Retry'),
    { ...message('elsewhere', 7, 'External'), channel_type: 'slack' },
  ];
  fake.events = [
    terminal(1, 'original', [
      { after: 0, upto: 1 },
      { after: 3, upto: 7 },
    ]),
  ];
  await service.collect(await store.getSession('s'));
  expect(await store.db.get('SELECT text FROM ws_activity')).toEqual({ text: 'Original Retry' });
});
it('records a failure without raw diagnostics or requiring a chat message', async () => {
  fake.events = [terminal(1, 'failure', [], true)];
  await service.collect(await store.getSession('s'));
  expect(await store.db.get('SELECT kind,text FROM ws_activity')).toMatchObject({
    kind: 'failure',
    text: expect.stringContaining('could not finish'),
  });
});
