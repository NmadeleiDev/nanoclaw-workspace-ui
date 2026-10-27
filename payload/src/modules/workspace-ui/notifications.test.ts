import { createECDH, randomBytes } from 'node:crypto';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { initTestDb, closeDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import './migration.js';
import { WorkspaceStore } from './store.js';
import { WorkspaceNotifications, validateSubscription, plainPreview, type PushTransport } from './notifications.js';
import type { WorkspaceSession } from './types.js';

let store: WorkspaceStore;
let notifications: WorkspaceNotifications;
let session: WorkspaceSession;
let projectId: string;
let send: ReturnType<typeof vi.fn<PushTransport>>;
let origin: string | null;
const host = 'https://mac.test.ts.net:8443';
const stamp = () => new Date().toISOString();
const receiver = createECDH('prime256v1');
receiver.generateKeys();
const subscription = {
  endpoint: 'https://web.push.apple.com/test',
  keys: { p256dh: receiver.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') },
};
beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(db);
  store = new WorkspaceStore(db);
  origin = host;
  await db.run('UPDATE ws_settings SET value=? WHERE id=?', '2000-01-01T00:00:00.000Z', 'notification-baseline');
  await db.run(
    'INSERT INTO agent_groups (id,name,folder,created_at) VALUES (?,?,?,?)',
    'agent',
    'Assistant',
    'assistant',
    stamp(),
  );
  await db.run(
    'INSERT INTO users (id,kind,display_name,created_at) VALUES (?,?,?,?)',
    'owner',
    'test',
    'Owner',
    stamp(),
  );
  await db.run(
    "INSERT INTO user_roles (user_id,role,agent_group_id,granted_at) VALUES (?,'owner',NULL,?)",
    'owner',
    stamp(),
  );
  await db.run(
    'INSERT INTO sessions (id,agent_group_id,thread_id,status,container_status,created_at) VALUES (?,?,?,?,?,?)',
    'native',
    'agent',
    'system:workspace:test',
    'active',
    'stopped',
    stamp(),
  );
  projectId = (await store.saveProject({ name: 'Project' })).id;
  session = await store.addSession({ id: 'native', nativeSessionId: 'native', agentId: 'agent', projectId });
  for (const id of ['phone', 'mac'])
    await db.run(
      'INSERT INTO ws_devices (id,owner_id,token_hash,origin,name,created_at,last_seen,push_enabled,subscription) VALUES (?,?,?,?,?,?,?,?,?)',
      id,
      'owner',
      id,
      host,
      id,
      stamp(),
      stamp(),
      1,
      JSON.stringify(subscription),
    );
  send = vi.fn<PushTransport>().mockResolvedValue({ statusCode: 201 });
  notifications = new WorkspaceNotifications(
    store,
    () => origin,
    () => {},
    send,
  );
  await notifications.start();
  await notifications.savePreference('owner', 'global', '', { mode: 'on' });
});
afterEach(async () => {
  await notifications.stop();
  vi.useRealTimers();
  await closeDb();
});
const record = (
  kind: 'reply' | 'question' | 'failure' | 'approval' = 'reply',
  source = 'source',
  requestId: string | null = null,
) => notifications.record(session, kind, '**Hello** [world](https://example.com)', source, stamp(), requestId);
const states = () => store.db.all<{ state: string }>('SELECT state FROM ws_push_outbox ORDER BY device_id');

it('resolves session > project > agent, with global as an absolute gate', async () => {
  expect(await notifications.effective('owner', session)).toMatchObject({ enabled: true, source: 'default' });
  await notifications.savePreference('owner', 'agent', 'agent', { mode: 'muted' });
  expect(await notifications.effective('owner', session)).toMatchObject({ enabled: false, source: 'agent' });
  await notifications.savePreference('owner', 'project', projectId, { mode: 'on' });
  expect(await notifications.effective('owner', session)).toMatchObject({ enabled: true, source: 'project' });
  await notifications.savePreference('owner', 'session', session.id, { mode: 'muted' });
  expect(await notifications.effective('owner', session)).toMatchObject({ enabled: false, source: 'session' });
  await notifications.savePreference('owner', 'session', session.id, { mode: 'on' });
  await notifications.savePreference('owner', 'global', '', { mode: 'muted' });
  expect(await notifications.effective('owner', session)).toMatchObject({ enabled: false, source: 'global' });
});
it('temporary pauses expire without destroying the previous preference', async () => {
  const now = Date.now();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  await notifications.savePreference('owner', 'session', session.id, {
    mode: 'on',
    snoozedUntil: new Date(now + 1000).toISOString(),
  });
  expect((await notifications.effective('owner', session)).enabled).toBe(false);
  vi.setSystemTime(now + 2000);
  expect((await notifications.effective('owner', session)).enabled).toBe(true);
});
it('records and queues each source once and sends encrypted-push options with stable tags', async () => {
  await record();
  await record();
  expect((await notifications.activity('owner')).items).toHaveLength(1);
  expect((await states()).length).toBe(2);
  await notifications.dispatch([]);
  await notifications.dispatch([]);
  expect(send).toHaveBeenCalledTimes(2);
  const payload = JSON.parse(send.mock.calls[0][1]!);
  expect(payload.notification).toMatchObject({
    title: 'Assistant · Project',
    body: 'New reply: Hello world',
    app_badge: '1',
  });
  expect(payload.notification.navigate).toContain('?session=native&activity=');
  expect(send.mock.calls[0][2]).toMatchObject({
    TTL: expect.any(Number),
    vapidDetails: { subject: host, privateKey: expect.any(String) },
  });
  expect(await states()).toEqual([{ state: 'accepted' }, { state: 'accepted' }]);
});
it('global off, changed scope and disabled event type are checked again at dispatch', async () => {
  await record();
  await notifications.savePreference('owner', 'project', projectId, { mode: 'muted' });
  await notifications.dispatch([]);
  expect(send).not.toHaveBeenCalled();
  await notifications.savePreference('owner', 'project', projectId, { mode: 'on' });
  const g = await notifications.preference('owner', 'global');
  await notifications.savePreference('owner', 'global', '', { kinds: { ...g.kinds, reply: false } });
  await record('reply', 'two');
  await notifications.dispatch([]);
  expect(send).not.toHaveBeenCalled();
  expect((await notifications.activity('owner')).items).toHaveLength(2);
});
it.each(['any', 'device', 'always'] as const)('reading suppression mode %s behaves across devices', async (reading) => {
  await notifications.savePreference('owner', 'global', '', { reading });
  await notifications.heartbeat('owner', 'mac', { clientId: 'tab', sessionId: session.id, active: true });
  await record();
  await notifications.dispatch([]);
  expect(send).toHaveBeenCalledTimes(reading === 'any' ? 0 : reading === 'device' ? 1 : 2);
});
it('attention requests still alert the other device while the session is being read', async () => {
  await notifications.heartbeat('owner', 'mac', { clientId: 'tab', sessionId: session.id, active: true });
  await record('question', 'question', 'q1');
  await notifications.dispatch([{ id: 'q1', type: 'question', session_id: session.id }]);
  expect(send).toHaveBeenCalledTimes(1);
});
it('expired reading leases cannot suppress delivery', async () => {
  const now = Date.now();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  await notifications.heartbeat('owner', 'mac', { clientId: 'tab', sessionId: session.id, active: true });
  vi.setSystemTime(now + 31000);
  await record();
  await notifications.dispatch([]);
  expect(send).toHaveBeenCalledTimes(2);
});
it('already-read replies and resolved requests do not create stale alerts', async () => {
  await record();
  await notifications.markRead('owner', session.id);
  await record('approval', 'approval', 'resolved');
  await notifications.dispatch([]);
  expect(send).not.toHaveBeenCalled();
});
it('does not replay history, imports, or external-channel conversations', async () => {
  await notifications.record(session, 'reply', 'old', 'old', '1999-01-01T00:00:00.000Z');
  await notifications.record({ ...session, origin: 'openclaw' }, 'reply', 'import', 'import', stamp());
  await store.db.run('UPDATE sessions SET thread_id=NULL WHERE id=?', session.id);
  await record();
  expect((await notifications.activity('owner')).items).toHaveLength(0);
});
it('discovers actionable requests once without an initial pending-request flood', async () => {
  await notifications.requests([{ id: 'existing', type: 'approval', session_id: session.id }]);
  expect((await notifications.activity('owner')).items).toHaveLength(0);
  await notifications.requests([
    { id: 'existing', type: 'approval', session_id: session.id },
    { id: 'new', type: 'question', session_id: session.id, question: 'Choose one' },
  ]);
  await notifications.requests([{ id: 'new', type: 'question', session_id: session.id, question: 'Choose one' }]);
  expect((await notifications.activity('owner')).items).toHaveLength(1);
});
it('revocation clears pending deliveries and removes private subscription material', async () => {
  await record();
  await notifications.updateDevice('owner', 'phone', { revoked: true });
  await notifications.dispatch([]);
  expect(send).toHaveBeenCalledTimes(1);
  expect(await store.db.get('SELECT subscription,push_enabled FROM ws_devices WHERE id=?', 'phone')).toEqual({
    subscription: null,
    push_enabled: 0,
  });
  expect(JSON.stringify(await notifications.settings('owner', 'mac'))).not.toContain('privateKey');
  expect(JSON.stringify(await notifications.devices('owner'))).not.toContain('token_hash');
});
it('subscription expiration disables push, while transient errors retain a retry across restart', async () => {
  send
    .mockRejectedValueOnce({ statusCode: 410 })
    .mockRejectedValueOnce({ statusCode: 503, headers: { 'retry-after': '120' } });
  await record();
  await notifications.dispatch([]);
  expect(await store.db.get('SELECT push_enabled,subscription FROM ws_devices WHERE push_enabled=0')).toEqual({
    push_enabled: 0,
    subscription: null,
  });
  const queued = await store.db.get<{ state: string; due_at: string }>(
    "SELECT state,due_at FROM ws_push_outbox WHERE state='pending'",
  );
  expect(queued?.state).toBe('pending');
  expect(Date.parse(queued!.due_at) - Date.now()).toBeGreaterThan(115000);
  await store.db.run("UPDATE ws_push_outbox SET due_at=? WHERE state='pending'", stamp());
  const restored = new WorkspaceNotifications(
    store,
    () => host,
    () => {},
    send,
  );
  await restored.start();
  await restored.dispatch([]);
  await restored.stop();
  expect(send).toHaveBeenCalledTimes(3);
});
it('tailnet withdrawal and owner access revocation stop push', async () => {
  await record();
  origin = null;
  await notifications.dispatch([]);
  expect(send).not.toHaveBeenCalled();
  origin = host;
  await record('reply', 'second');
  await store.db.run('DELETE FROM user_roles WHERE user_id=?', 'owner');
  await notifications.dispatch([]);
  expect(send).not.toHaveBeenCalled();
});
it('privacy modes strip content or names from the payload', async () => {
  await notifications.savePreference('owner', 'global', '', { preview: 'private' });
  await record();
  await notifications.dispatch([]);
  const payload = JSON.parse(send.mock.calls[0][1]!);
  expect(payload.notification.title).toBe('NanoClaw');
  expect(payload.notification.body).not.toContain('world');
  expect(payload.notification.body).not.toContain('Project');
});
it('validates subscription hosts and encryption key shapes without making network requests', () => {
  expect(validateSubscription(subscription)).toEqual(subscription);
  for (const endpoint of [
    'http://web.push.apple.com/test',
    'https://127.0.0.1/test',
    'https://web.push.apple.com.evil.test/test',
    'https://web.push.apple.com:3210/test',
    'https://user@web.push.apple.com/test',
  ])
    expect(() => validateSubscription({ ...subscription, endpoint })).toThrow();
  expect(() => validateSubscription({ ...subscription, keys: { p256dh: 'x', auth: 'y' } })).toThrow();
  expect(plainPreview('<b>Hi</b> **friend**')).toBe('Hi friend');
  expect(Array.from(plainPreview('😀'.repeat(300)))).toHaveLength(200);
});

it('counts all eligible unread activity rather than only the visible recent page', async () => {
  for (let i = 0; i < 205; i++) await record('reply', `event-${i}`);
  const feed = await notifications.activity('owner');
  expect(feed.items).toHaveLength(200);
  expect(feed.badge).toBe(205);
});
