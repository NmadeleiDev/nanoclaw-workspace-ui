import { randomUUID } from 'node:crypto';
import { getDb } from '../../db/connection.js';
import type { DbDriver } from '../../db/driver.js';
import { APPROVAL_HISTORY_RETENTION_MS } from './deadlines.js';
export async function approvalEvent(db: DbDriver, id: string, kind: string, data: unknown = {}) {
  await db.transaction(async () => {
    const row = await db.get<{ n: number }>(
      'SELECT COALESCE(MAX(sequence),0)+1 AS n FROM approval_events WHERE approval_id=?',
      id,
    );
    await db.run(
      'INSERT INTO approval_events (id,approval_id,kind,data,created_at,sequence) VALUES (?,?,?,?,?,?)',
      randomUUID(),
      id,
      kind,
      JSON.stringify(data),
      new Date().toISOString(),
      row!.n,
    );
  });
}
export async function applicationResult(id: string, state: 'applied' | 'failed' | 'uncertain', error?: string) {
  const db = getDb();
  await db.transaction(async () => {
    const result = await db.run(
      "UPDATE pending_approvals SET application_state=?,application_error=? WHERE approval_id=? AND status='approved' AND application_state IN ('applying','uncertain')",
      state,
      error ? 'Application failed; inspect protected operator logs.' : null,
      id,
    );
    if (result.changes) await approvalEvent(db, id, `application:${state}`);
  });
}
export async function archiveApproval(id: string) {
  const db = getDb();
  await db.transaction(async () => {
    const row = await db.get<any>('SELECT * FROM pending_approvals WHERE approval_id=? AND archived_at IS NULL', id);
    if (!row) return;
    const now = new Date().toISOString();
    const status = ['pending', 'awaiting_reason'].includes(row.status)
      ? row.expires_at && Date.parse(row.expires_at) <= Date.now()
        ? 'expired'
        : 'cancelled'
      : row.status;
    const application =
      row.status === 'approved' && row.application_state === 'applying' ? 'uncertain' : row.application_state;
    await db.run(
      'UPDATE pending_approvals SET archived_at=?,status=?,application_state=? WHERE approval_id=?',
      now,
      status,
      application,
      id,
    );
    await approvalEvent(db, id, 'archived', { status, application });
  });
  await (await import('./recovery.js')).queueApprovalOutcome(id);
}
export async function approvalHistory(sessionId?: string, before?: string) {
  const db = getDb();
  const rows = await db.all<any>(
    `SELECT approval_id AS id,session_id,agent_group_id,title,question,status,created_at,expires_at,decided_at,decided_by,decision_comment,decision_value,application_state,application_error,archived_at FROM pending_approvals WHERE archived_at IS NOT NULL ${sessionId ? 'AND session_id=?' : ''} ${before ? 'AND (archived_at || approval_id)<?' : ''} ORDER BY archived_at DESC,approval_id DESC LIMIT 51`,
    ...(sessionId ? [sessionId] : []),
    ...(before ? [before] : []),
  );
  const items = rows.slice(0, 50);
  return { items, next: rows.length > 50 ? `${items[49].archived_at}${items[49].id}` : null };
}
export async function pruneApprovalHistory() {
  const db = getDb();
  const cutoff = new Date(Date.now() - APPROVAL_HISTORY_RETENTION_MS).toISOString();
  await db.transaction(async () => {
    await db.run(
      "UPDATE approval_waits SET state='cancelled',updated_at=? WHERE state='waiting' AND (NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id=approval_waits.session_id) OR NOT EXISTS (SELECT 1 FROM pending_approvals p WHERE p.approval_id=approval_waits.request_id))",
      new Date().toISOString(),
    );
    await db.run(
      'DELETE FROM approval_events WHERE created_at<? AND NOT EXISTS (SELECT 1 FROM pending_approvals p WHERE p.approval_id=approval_events.approval_id)',
      cutoff,
    );
    await db.run(
      "DELETE FROM approval_events WHERE approval_id IN (SELECT approval_id FROM pending_approvals WHERE archived_at<? AND application_state NOT IN ('applying','uncertain'))",
      cutoff,
    );
    await db.run(
      "DELETE FROM pending_approvals WHERE archived_at<? AND application_state NOT IN ('applying','uncertain')",
      cutoff,
    );
    await db.run('DELETE FROM approval_outbox WHERE delivered_at<?', cutoff);
    await db.run("DELETE FROM approval_waits WHERE state IN ('complete','cancelled') AND updated_at<?", cutoff);
  });
}
