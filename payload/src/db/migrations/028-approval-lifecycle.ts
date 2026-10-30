import { randomUUID } from 'node:crypto';
import type { Migration } from './index.js';
export const migration028: Migration = {
  version: 28,
  name: 'approval-lifecycle',
  async up(db) {
    for (const definition of [
      'archived_at TEXT',
      'decision_comment TEXT',
      'decision_value TEXT',
      'decided_by TEXT',
      'decided_at TEXT',
      "application_state TEXT NOT NULL DEFAULT 'not_started'",
      'application_error TEXT',
      'reason_deadline_at TEXT',
    ])
      await db.exec(`ALTER TABLE pending_approvals ADD COLUMN ${definition}`);
    await db.exec(`CREATE TABLE approval_events (id TEXT PRIMARY KEY,approval_id TEXT NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL,sequence INTEGER NOT NULL,UNIQUE(approval_id,sequence));
   CREATE INDEX approval_events_request ON approval_events(approval_id,created_at);
   CREATE INDEX approval_live_deadlines ON pending_approvals(archived_at,status,expires_at);
   CREATE TABLE approval_waits (session_id TEXT NOT NULL,request_id TEXT NOT NULL,context TEXT NOT NULL,state TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(session_id,request_id));
   CREATE TABLE approval_outbox (id TEXT PRIMARY KEY,session_id TEXT NOT NULL,approval_id TEXT NOT NULL,content TEXT NOT NULL,delivered_at TEXT,created_at TEXT NOT NULL);`);
    const now = new Date().toISOString();
    await db.run(
      "UPDATE pending_approvals SET expires_at=? WHERE expires_at IS NULL AND status='pending'",
      new Date(Date.parse(now) + 600000).toISOString(),
    );
    await db.run("UPDATE pending_approvals SET application_state='uncertain' WHERE status='approved'");
    for (const row of await db.all<{ approval_id: string }>('SELECT approval_id FROM pending_approvals'))
      await db.run(
        'INSERT INTO approval_events(id,approval_id,kind,data,created_at,sequence) VALUES (?,?,?,?,?,1)',
        randomUUID(),
        row.approval_id,
        'imported',
        '{}',
        now,
      );
  },
};
