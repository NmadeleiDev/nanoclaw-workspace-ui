import './mailbox/compose.js';
import { beforeEach, expect, test } from 'bun:test';
import { initTestSessionDb, getInboundDb, getOutboundDb } from './mailbox/sqlite/connection.js';
import { getAgentMailbox } from './mailbox/index.js';
import { beginApprovalWait, checkApprovalWait, supportsApprovalWait } from './approval-wait.js';
beforeEach(() => {
  initTestSessionDb();
  getInboundDb().exec('CREATE TABLE IF NOT EXISTS workspace_context (id INTEGER PRIMARY KEY,value TEXT,control TEXT)');
});
function control(value: object) {
  getInboundDb()
    .prepare('INSERT OR REPLACE INTO workspace_context (id,value,control) VALUES (1,?,?)')
    .run('{}', JSON.stringify(value));
}
test('wait survives state reads and rejects a policy-restart cancel as a user decision', () => {
  beginApprovalWait('request');
  expect(checkApprovalWait()).toBe(true);
  control({ kind: 'cancel', at: new Date(Date.now() + 1000).toISOString() });
  expect(checkApprovalWait()).toBe(true);
  control({ kind: 'approval_resolved', at: new Date(Date.now() + 1000).toISOString() });
  expect(checkApprovalWait()).toBe(false);
});
test('explicit task cancellation clears a wait and completes its suspended acknowledgements', () => {
  beginApprovalWait('request');
  const box = getAgentMailbox().operations;
  box.markMessages(['message'], 'waiting_approval');
  box.setState('approval_wait_ids', '["message"]');
  control({ kind: 'cancel', approvalCancelled: true, at: new Date(Date.now() + 1000).toISOString() });
  expect(checkApprovalWait()).toBe(false);
  expect(
    (getOutboundDb().prepare('SELECT status FROM processing_ack WHERE message_id=?').get('message') as any).status,
  ).toBe('completed');
});

test('negotiates durable blocking with the host and adopts host-initiated waits', () => {
  expect(supportsApprovalWait()).toBe(false);
  getInboundDb()
    .prepare('INSERT OR REPLACE INTO workspace_context (id,value,control) VALUES (1,?,NULL)')
    .run('{"approvalProtocol":1}');
  expect(supportsApprovalWait()).toBe(true);
  control({ kind: 'approval_wait', requestId: 'new-host', at: new Date().toISOString() });
  expect(checkApprovalWait()).toBe(true);
  control({ kind: 'approval_resolved', at: new Date(Date.now() + 1000).toISOString() });
  expect(checkApprovalWait()).toBe(false);
});

test('checkpoints in-flight messages before a crash can clear their processing claims', () => {
  const box = getAgentMailbox().operations;
  box.markMessages(['original'], 'processing');
  beginApprovalWait('crash-before-stream-abort');
  box.clearStaleProcessingAcks();
  expect(
    (getOutboundDb().prepare('SELECT status FROM processing_ack WHERE message_id=?').get('original') as any).status,
  ).toBe('waiting_approval');
  control({ kind: 'approval_resolved', at: new Date(Date.now() + 1000).toISOString() });
  expect(checkApprovalWait()).toBe(false);
  expect(
    (getOutboundDb().prepare('SELECT status FROM processing_ack WHERE message_id=?').get('original') as any).status,
  ).toBe('completed');
});

test('commits the outbound permission request and task checkpoint atomically', async () => {
  const box = getAgentMailbox().operations;
  box.markMessages(['original'], 'processing');
  await box.writeMessageOut({ id: 'permission-request', kind: 'system', content: '{}' }, 'atomic-request');
  expect(checkApprovalWait()).toBe(true);
  expect(getOutboundDb().prepare('SELECT id FROM messages_out WHERE id=?').get('permission-request')).toBeTruthy();
  control({ kind: 'approval_resolved', at: new Date(Date.now() + 1000).toISOString() });
  checkApprovalWait();
  await expect(
    box.writeMessageOut({ id: 'permission-request', kind: 'system', content: '{}' }, 'failed-request'),
  ).rejects.toThrow();
  expect(checkApprovalWait()).toBe(false);
});
