import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createPendingApproval, transitionPendingApprovalStatus } from '../../db/sessions.js';
import { pauseForApproval, reconcileApprovals, queueApprovalOutcome, cancelApprovalWait } from './recovery.js';
const fake = vi.hoisted(() => ({ controls: [] as any[], messages: new Map<string, any>(), wake: vi.fn() }));
vi.mock('../../session-manager.js', () => ({
  withMailboxSession: async (_a: string, _s: string, fn: any) =>
    fn({
      getProcessingClaims: () => [{ messageId: 'original-message' }],
      setWorkspaceControl: (value: string) => fake.controls.push(JSON.parse(value)),
    }),
  writeSessionMessage: async (_a: string, _s: string, msg: any) => {
    fake.messages.set(msg.id, msg);
  },
}));
vi.mock('../../request-wake.js', () => ({ requestWake: (...args: any[]) => fake.wake(...args) }));
beforeEach(async () => {
  fake.controls = [];
  fake.messages.clear();
  fake.wake.mockClear();
  await runMigrations(await initTestDb());
  const db = getDb();
  const now = new Date().toISOString();
  await db.run(
    'INSERT INTO agent_groups(id,name,folder,created_at) VALUES (?,?,?,?)',
    'agent',
    'Assistant',
    'demo',
    now,
  );
  await db.run(
    'INSERT INTO sessions(id,agent_group_id,status,container_status,created_at) VALUES (?,?,?,?,?)',
    'session',
    'agent',
    'active',
    'stopped',
    now,
  );
});
afterEach(closeDb);
const seed = (id: string) =>
  createPendingApproval({
    approval_id: id,
    session_id: 'session',
    request_id: id,
    action: 'native_access_request',
    payload: '{}',
    title: 'Allow a port?',
    options_json: '["session","deny"]',
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 600000).toISOString(),
  });
it('keeps a task paused until all concurrent requests resolve and sends each outcome once', async () => {
  await seed('one');
  await seed('two');
  await pauseForApproval('session', 'one');
  await pauseForApproval('session', 'two');
  await transitionPendingApprovalStatus('one', 'pending', 'rejected', {
    userId: 'web:owner',
    comment: 'Use a different port.',
  });
  await queueApprovalOutcome('one');
  await reconcileApprovals();
  expect(fake.controls.at(-1).kind).toBe('approval_wait');
  await transitionPendingApprovalStatus('two', 'pending', 'rejected');
  await reconcileApprovals();
  await reconcileApprovals();
  expect(fake.controls.at(-1).kind).toBe('approval_resolved');
  expect(fake.messages.size).toBe(2);
  expect([...fake.messages.values()][0].content).toContain('Use a different port.');
  expect(await getDb().all("SELECT * FROM approval_waits WHERE state='waiting'")).toHaveLength(0);
});
it('expires a durable wait and delivers a no-grant outcome without approving anything', async () => {
  await seed('one');
  await pauseForApproval('session', 'one');
  await getDb().run('UPDATE pending_approvals SET expires_at=?', new Date(Date.now() - 1).toISOString());
  await reconcileApprovals();
  const row = await getDb().get<any>('SELECT * FROM pending_approvals WHERE approval_id=?', 'one');
  expect(row.status).toBe('expired');
  expect(row.archived_at).toBeTruthy();
  expect(fake.messages.size).toBe(1);
  expect([...fake.messages.values()][0].onWake).toBe(false);
  expect([...fake.messages.values()][0].content).toContain('No new permission was granted');
});

it('cancels a paused task without delivering a late approval outcome', async () => {
  await seed('one');
  await pauseForApproval('session', 'one');
  await cancelApprovalWait('session');
  await queueApprovalOutcome('one');
  await reconcileApprovals();
  expect(fake.messages.size).toBe(0);
  expect((await getDb().get<any>('SELECT status FROM pending_approvals WHERE approval_id=?', 'one')).status).toBe(
    'cancelled',
  );
  expect(await transitionPendingApprovalStatus('one', 'pending', 'approved')).toBe(false);
});
it('retries a failed mailbox delivery without duplicating the durable outcome', async () => {
  await seed('one');
  await pauseForApproval('session', 'one');
  await transitionPendingApprovalStatus('one', 'pending', 'rejected');
  fake.wake.mockRejectedValueOnce(new Error('temporary wake outage'));
  await reconcileApprovals();
  expect((await getDb().get<any>('SELECT delivered_at FROM approval_outbox')).delivered_at).toBeNull();
  await reconcileApprovals();
  expect(fake.messages.size).toBe(1);
  expect((await getDb().get<any>('SELECT delivered_at FROM approval_outbox')).delivered_at).toBeTruthy();
});
