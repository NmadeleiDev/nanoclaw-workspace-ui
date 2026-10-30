import fs from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => process.cwd() + '/.cache/approval-outbox-mailbox');
vi.mock('../../config.js', async () => ({
  ...(await vi.importActual('../../config.js')),
  DATA_DIR: fixture,
}));
import '../../mailbox/compose.js';
import { initTestDb, closeDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createSession } from '../../db/sessions.js';
import { destroySessionMailbox, withMailboxSession, writeSessionMessage } from '../../session-manager.js';

afterEach(async () => {
  await destroySessionMailbox('fixture', 'outbox');
  await closeDb();
  fs.rmSync(fixture, { recursive: true, force: true });
});
it('retries a durable outcome against the real mailbox exactly once and rejects identity reuse', async () => {
  await runMigrations(await initTestDb());
  const now = new Date().toISOString();
  await createAgentGroup({
    id: 'fixture',
    name: 'Fixture',
    folder: 'outbox-fixture',
    created_at: now,
    agent_provider: null,
  });
  await createSession({
    id: 'outbox',
    agent_group_id: 'fixture',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now,
  });
  const message = {
    id: 'approval-outcome:fixture',
    kind: 'chat' as const,
    timestamp: now,
    content: '{"text":"Declined; use another port."}',
    idempotent: true,
  };
  await writeSessionMessage('fixture', 'outbox', message);
  await writeSessionMessage('fixture', 'outbox', message);
  const rows = await withMailboxSession('fixture', 'outbox', (box) => box.getWorkspaceInbound!(0, 10));
  expect(rows).toHaveLength(1);
  expect(rows[0].content).toBe(message.content);
  await expect(writeSessionMessage('fixture', 'outbox', { ...message, content: 'different payload' })).rejects.toThrow(
    'different content',
  );
});
