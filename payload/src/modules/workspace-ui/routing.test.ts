import fs from 'node:fs';
import Database from 'better-sqlite3';
import path from 'node:path';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { initTestDb, closeDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import '../../mailbox/compose.js';
import { routeOperatorMessage } from '../../router.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import { requestWake } from '../../request-wake.js';

vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn(async () => true) }));
vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: `${process.cwd()}/.cache/workspace-routing-${process.pid}` };
});
const root = path.resolve(`.cache/workspace-routing-${process.pid}`);
beforeEach(async () => {
  fs.mkdirSync(root, { recursive: true });
  vi.clearAllMocks();
  const db = await initTestDb();
  await runMigrations(db);
  const at = new Date().toISOString();
  await db.run(
    'INSERT INTO users (id,kind,display_name,created_at) VALUES (?,?,?,?)',
    'telegram:owner',
    'telegram',
    'Owner',
    at,
  );
  await db.run(
    'INSERT INTO user_roles (user_id,role,agent_group_id,granted_at) VALUES (?,?,NULL,?)',
    'telegram:owner',
    'owner',
    at,
  );
  await db.run('INSERT INTO agent_groups (id,name,folder,created_at) VALUES (?,?,?,?)', 'assistant', 'Assistant', 'assistant', at);
  await db.run(
    'INSERT INTO messaging_groups (id,channel_type,instance,platform_id,name,is_group,unknown_sender_policy,created_at) VALUES (?,?,?,?,?,?,?,?)',
    'telegram-chat',
    'telegram',
    'telegram',
    '12345',
    'Owner chat',
    0,
    'strict',
    at,
  );
  await db.run(
    'INSERT INTO sessions (id,agent_group_id,messaging_group_id,thread_id,status,container_status,created_at) VALUES (?,?,?,?,?,?,?)',
    'native',
    'assistant',
    'telegram-chat',
    null,
    'active',
    'stopped',
    at,
  );
});
afterEach(async () => {
  await closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

it('sends to the exact existing Telegram mailbox, saves attachments, and deduplicates a retried web submission', async () => {
  const message = {
    id: 'web-abcdefgh',
    timestamp: new Date().toISOString(),
    content: JSON.stringify({
      text: 'Review this note',
      _workspaceRequestDigest: 'same',
      source: 'web',
      attachments: [{ name: 'note.txt', data: Buffer.from('A note').toString('base64'), mimeType: 'text/plain' }],
    }),
  };
  expect(await routeOperatorMessage('native', 'telegram:owner', message)).toEqual({ queued: false, duplicate: false });
  const row = await withExistingMailboxSession('assistant', 'native', (box) => box.getWorkspaceMessage?.(message.id));
  expect(row).toMatchObject({ channel_type: 'telegram' });
  const mailbox = new Database(path.join(root, 'v2-sessions/assistant/native/inbound.db'), { readonly: true });
  try {
    expect(mailbox.prepare('SELECT platform_id,channel_type FROM messages_in WHERE id=?').get(message.id)).toEqual({
      platform_id: '12345',
      channel_type: 'telegram',
    });
  } finally {
    mailbox.close();
  }
  const content = JSON.parse(row!.content);
  expect(content.attachments[0].data).toBeUndefined();
  expect(content.attachments[0].localPath).toContain('inbox/');
  expect(await routeOperatorMessage('native', 'telegram:owner', message)).toEqual({ queued: true, duplicate: true });
  expect(requestWake).toHaveBeenCalledTimes(1);
  await expect(
    routeOperatorMessage('native', 'telegram:owner', {
      ...message,
      content: JSON.stringify({ _workspaceRequestDigest: 'different' }),
    }),
  ).rejects.toThrow('already used');
  await expect(routeOperatorMessage('native', 'telegram:stranger', { ...message, id: 'web-ijklmnop' })).rejects.toThrow(
    'Owner',
  );
});
