import { getDb } from '../../db/connection.js';
import { getSession, transitionPendingApprovalStatus, deletePendingApproval } from '../../db/sessions.js';
import { withMailboxSession, writeSessionMessage } from '../../session-manager.js';
import { onHostStart, onHostShutdown } from '../../host-lifecycle.js';
import { requestWake } from '../../request-wake.js';
import { approvalEvent, pruneApprovalHistory } from './lifecycle.js';
import { log } from '../../log.js';
let timer: ReturnType<typeof setInterval> | undefined;
let working = false;
let lastPrune = 0;
export async function pauseForApproval(sessionId: string, requestId: string) {
  const db = getDb();
  const session = await getSession(sessionId);
  if (!session) return;
  await withMailboxSession(session.agent_group_id, session.id, async (box) => {
    const checkpoint = box.getWorkspaceState?.('approval_wait_ids');
    const claims = [
      ...new Set([
        ...box.getProcessingClaims().map((c) => c.messageId),
        ...(checkpoint ? (JSON.parse(checkpoint) as string[]) : []),
      ]),
    ];
    await db.run(
      `INSERT INTO approval_waits(session_id,request_id,context,state,updated_at) VALUES (?,?,?,'waiting',?) ON CONFLICT(session_id,request_id) DO UPDATE SET context=excluded.context,state='waiting',updated_at=excluded.updated_at`,
      sessionId,
      requestId,
      JSON.stringify({ messageIds: claims }),
      new Date().toISOString(),
    );
    box.setWorkspaceControl?.(JSON.stringify({ kind: 'approval_wait', requestId, at: new Date().toISOString() }));
  });
}
export async function queueApprovalOutcome(id: string) {
  const db = getDb();
  await db.transaction(async () => {
    const row = await db.get<any>('SELECT * FROM pending_approvals WHERE approval_id=?', id);
    if (!row?.session_id) return;
    if (await db.get("SELECT request_id FROM approval_waits WHERE request_id=? AND state='cancelled'", id)) return;
    const wait = await db.get<any>(
      "SELECT * FROM approval_waits WHERE session_id=? AND request_id=? AND state='waiting'",
      row.session_id,
      id,
    );
    if (
      !wait &&
      !row.decision_comment &&
      row.status === 'expired' &&
      !(await db.get("SELECT id FROM approval_events WHERE approval_id=? AND kind='created'", id))
    )
      return;
    if (!wait && !row.decision_comment && row.status === 'approved' && row.application_state === 'uncertain') return;
    if (
      !wait &&
      !row.decision_comment &&
      row.action !== 'native_access_request' &&
      !['rejected', 'expired'].includes(row.status)
    )
      return;
    if (row.status === 'approved' && !['applied', 'failed', 'uncertain'].includes(row.application_state)) return;
    const outcome = row.status === 'approved' ? row.application_state : row.status;
    const structured = {
      protocol: 1,
      approvalId: id,
      decision: row.status,
      selectedOption: row.decision_value,
      applicationState: row.application_state,
    };
    const text = `${row.status === 'rejected' ? `Your ${row.action} request was rejected by admin${row.decision_comment ? `: "${row.decision_comment}"` : '.'}` : `Approval ${id}: ${outcome}.`} ${row.status === 'approved' && row.application_state === 'applied' ? 'The granted permission is now available.' : row.status === 'approved' ? 'Permission application was not verified. Inspect the recorded state; do not repeat the operation automatically.' : 'No new permission was granted. Explain the blocker or choose a permitted alternative; do not automatically request the same permission again in this task.'} Inspect recorded results before repeating any side effect.${row.decision_comment && row.status !== 'rejected' ? `\nOperator comment (context only, not an additional grant): ${row.decision_comment}` : ''}`;
    await db.run(
      `INSERT INTO approval_outbox(id,session_id,approval_id,content,created_at) VALUES (?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
      `approval-outcome:${id}`,
      row.session_id,
      id,
      JSON.stringify({
        text: text + '\nApproval status: ' + JSON.stringify(structured),
        approval: structured,
        sender: 'system',
        senderId: 'system',
      }),
      new Date().toISOString(),
    );
  });
}
export async function reconcileApprovals() {
  if (working) return;
  working = true;
  try {
    const db = getDb();
    const now = new Date().toISOString();
    if (Date.now() - lastPrune > 86400000) {
      await pruneApprovalHistory();
      lastPrune = Date.now();
    }
    for (const row of await db.all<any>(
      "SELECT * FROM pending_approvals WHERE archived_at IS NULL AND status='pending' AND expires_at<=?",
      now,
    )) {
      // The gateway owns acknowledgement of held external requests.
      if (row.action === 'gateway_request') continue;
      if (await transitionPendingApprovalStatus(row.approval_id, 'pending', 'expired')) {
        await queueApprovalOutcome(row.approval_id);
        await deletePendingApproval(row.approval_id);
      }
    }
    for (const row of await db.all<any>(
      "SELECT approval_id FROM pending_approvals WHERE archived_at IS NULL AND action<>'gateway_request' AND (status IN ('rejected','expired','cancelled') OR (status='approved' AND application_state IN ('applied','failed','uncertain')))",
    ))
      await deletePendingApproval(row.approval_id);
    for (const row of await db.all<any>(
      "SELECT p.* FROM pending_approvals p JOIN approval_waits w ON w.request_id=p.approval_id WHERE w.state='waiting' AND p.status NOT IN ('pending','awaiting_reason')",
    ))
      await queueApprovalOutcome(row.approval_id);
    for (const item of await db.all<any>(
      'SELECT * FROM approval_outbox WHERE delivered_at IS NULL ORDER BY created_at',
    )) {
      try {
        const session = await getSession(item.session_id);
        if (!session) {
          await db.run('UPDATE approval_outbox SET delivered_at=? WHERE id=?', now, item.id);
          await approvalEvent(db, item.approval_id, 'resume:cancelled', { reason: 'session no longer exists' });
          continue;
        }
        await writeSessionMessage(session.agent_group_id, session.id, {
          id: item.id,
          kind: 'chat',
          timestamp: item.created_at,
          // A denied or expired request resumes the existing paused runner too.
          // Successful permission application already verified the old runner exited.
          onWake: false,
          idempotent: true,
          content: item.content,
        });
        await db.run(
          "UPDATE approval_waits SET state='complete',updated_at=? WHERE session_id=? AND request_id=?",
          now,
          item.session_id,
          item.approval_id,
        );
        const remaining = await db.get<any>(
          "SELECT request_id FROM approval_waits WHERE session_id=? AND state='waiting'",
          session.id,
        );
        await withMailboxSession(session.agent_group_id, session.id, (box) =>
          box.setWorkspaceControl?.(
            JSON.stringify({
              kind: remaining ? 'approval_wait' : 'approval_resolved',
              requestId: remaining?.request_id ?? item.approval_id,
              at: now,
            }),
          ),
        );
        await requestWake(session, 'approval-response');
        await db.run('UPDATE approval_outbox SET delivered_at=? WHERE id=?', now, item.id);
      } catch (err) {
        log.error('Approval outcome remains queued for retry', { approvalId: item.approval_id, err });
      }
    }
  } finally {
    working = false;
  }
}
onHostStart(async () => {
  const db = getDb();
  for (const row of await db.all<any>(
    "SELECT approval_id,action FROM pending_approvals WHERE application_state='applying'",
  )) {
    await db.run("UPDATE pending_approvals SET application_state='uncertain' WHERE approval_id=?", row.approval_id);
    await approvalEvent(db, row.approval_id, 'application:uncertain', { reason: 'host restarted during application' });
    if (row.action !== 'gateway_request') await deletePendingApproval(row.approval_id);
  }
  for (const row of await db.all<any>(
    "SELECT p.session_id,p.approval_id FROM pending_approvals p WHERE p.action='native_access_request' AND p.status='pending' AND p.archived_at IS NULL AND p.expires_at>? AND NOT EXISTS(SELECT 1 FROM approval_waits w WHERE w.request_id=p.approval_id)",
    new Date().toISOString(),
  ))
    if (row.session_id) await pauseForApproval(row.session_id, row.approval_id);
  await reconcileApprovals();
  await pruneApprovalHistory();
  timer = setInterval(
    () => void reconcileApprovals().catch((err) => log.error('Approval reconciliation failed', { err })),
    5000,
  );
});
onHostShutdown(async () => {
  if (timer) clearInterval(timer);
  while (working) await new Promise((resolve) => setTimeout(resolve, 10));
});

export async function cancelApprovalWait(sessionId: string) {
  const db = getDb();
  await db.transaction(async () => {
    const waits = await db.all<any>(
      "SELECT request_id FROM approval_waits WHERE session_id=? AND state='waiting'",
      sessionId,
    );
    for (const wait of waits) {
      await transitionPendingApprovalStatus(wait.request_id, 'pending', 'cancelled');
      await approvalEvent(db, wait.request_id, 'task:cancelled', { source: 'workspace' });
      await db.run(
        "UPDATE pending_approvals SET archived_at=? WHERE approval_id=? AND status='cancelled'",
        new Date().toISOString(),
        wait.request_id,
      );
      await db.run(
        'UPDATE approval_outbox SET delivered_at=? WHERE approval_id=? AND delivered_at IS NULL',
        new Date().toISOString(),
        wait.request_id,
      );
    }
    await db.run(
      "UPDATE approval_waits SET state='cancelled',updated_at=? WHERE session_id=? AND state='waiting'",
      new Date().toISOString(),
      sessionId,
    );
  });
}
