import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import {
  createPendingApproval,
  getPendingApproval,
  transitionPendingApprovalStatus,
  deletePendingApproval,
} from '../../db/sessions.js';
import { approvalHistory, applicationResult, pruneApprovalHistory } from './lifecycle.js';
vi.mock('../../session-manager.js', () => ({ withMailboxSession: vi.fn(), writeSessionMessage: vi.fn() }));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn() }));
beforeEach(async () => {
  await runMigrations(await initTestDb());
});
afterEach(async () => {
  vi.useRealTimers();
  await closeDb();
});
const seed = async (id = 'request') =>
  createPendingApproval({
    approval_id: id,
    request_id: id,
    action: 'fixture',
    payload: '{}',
    created_at: new Date().toISOString(),
    title: 'Approve fixture?',
    options_json: '["approve","reject"]',
    expires_at: new Date(Date.now() + 600000).toISOString(),
  });
it('claims only one concurrent decision and keeps the decision, comment, and failed application history', async () => {
  await seed();
  const results = await Promise.all([
    transitionPendingApprovalStatus('request', 'pending', 'approved', {
      userId: 'web:owner',
      comment: 'Use port 8080.',
    }),
    transitionPendingApprovalStatus('request', 'pending', 'rejected', { userId: 'web:owner' }),
  ]);
  expect(results.filter(Boolean)).toHaveLength(1);
  await applicationResult('request', 'failed', 'Protected diagnostic');
  await deletePendingApproval('request');
  expect(await getPendingApproval('request')).toBeUndefined();
  expect((await approvalHistory()).items[0]).toMatchObject({
    status: 'approved',
    application_state: 'failed',
    decision_comment: 'Use port 8080.',
    decided_by: 'web:owner',
  });
  expect(await getDb().all("SELECT * FROM approval_events WHERE kind='decision'")).toHaveLength(1);
});
it('does not approve at the deadline and permits expiry to win exactly once', async () => {
  await seed();
  await getDb().run('UPDATE pending_approvals SET expires_at=?', new Date(Date.now() - 1).toISOString());
  expect(await transitionPendingApprovalStatus('request', 'pending', 'approved')).toBe(false);
  expect(await transitionPendingApprovalStatus('request', 'pending', 'expired')).toBe(true);
  expect(await transitionPendingApprovalStatus('request', 'pending', 'expired')).toBe(false);
  await deletePendingApproval('request');
  expect((await approvalHistory()).items[0].status).toBe('expired');
});
it('does not describe interrupted application as successful', async () => {
  await seed();
  await transitionPendingApprovalStatus('request', 'pending', 'approved');
  await deletePendingApproval('request');
  expect((await approvalHistory()).items[0].application_state).toBe('uncertain');
});
it('prunes only settled history older than 90 days', async () => {
  await seed('settled');
  await seed('uncertain');
  await transitionPendingApprovalStatus('settled', 'pending', 'rejected');
  await deletePendingApproval('settled');
  await transitionPendingApprovalStatus('uncertain', 'pending', 'approved');
  await deletePendingApproval('uncertain');
  await getDb().run("UPDATE pending_approvals SET archived_at='2000-01-01T00:00:00.000Z'");
  await pruneApprovalHistory();
  expect((await approvalHistory()).items.map((row) => row.id)).toEqual(['uncertain']);
});
