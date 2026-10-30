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
import './migration.js';
import { WorkspaceStore } from './store.js';
import { WorkspaceService } from './service.js';
import { startWorkspaceServer } from './server.js';

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
  await db.run('INSERT INTO agent_groups (id,name,folder,created_at) VALUES (?,?,?,?)', 'assistant', 'Rene', 'assistant', at);
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

it('keeps same-named images distinct through routing, storage, projection, and retry', async () => {
  const longName = `${'图'.repeat(83)}ab.png`;
  const names = ['image.png', 'image.png', 'image (2).png', 'IMAGE.PNG', longName, longName, 'é.png', 'e\u0301.png'];
  const message = {
    id: 'web-duplicate-images',
    timestamp: new Date().toISOString(),
    content: JSON.stringify({
      text: 'Compare these images',
      _workspaceRequestDigest: 'duplicate-images',
      source: 'web',
      attachments: names.map((name, i) => ({
        name,
        mimeType: 'image/png',
        data: Buffer.from(`image-${i}`).toString('base64'),
      })),
    }),
  };
  await routeOperatorMessage('native', 'telegram:owner', message);
  const row = await withExistingMailboxSession('assistant', 'native', (box) => box.getWorkspaceMessage?.(message.id));
  const attachments: Array<{ name: string; localPath: string; data?: string }> = JSON.parse(row!.content).attachments;
  expect(new Set(attachments.map((file) => file.name.normalize('NFC').toLowerCase())).size).toBe(names.length);
  expect(attachments[0].name).toBe('image.png');
  expect(attachments[1].name).toBe('image (3).png');
  expect(attachments[2].name).toBe('image (2).png');
  for (const [i, file] of attachments.entries()) {
    expect(file.data).toBeUndefined();
    expect(file.name).toMatch(/\.png$/i);
    expect(Buffer.byteLength(file.name)).toBeLessThanOrEqual(255);
    expect(fs.readFileSync(path.join(root, 'v2-sessions/assistant/native', file.localPath), 'utf8')).toBe(`image-${i}`);
  }
  const { getDb } = await import('../../db/connection.js');
  const store = new WorkspaceStore(getDb());
  await store.addSession({ id: 'native', nativeSessionId: 'native', agentId: 'assistant' });
  const service = new WorkspaceService(store);
  try {
    await service.collect(await store.getSession('native'));
    const projected = await store.db.get<{ files: string }>(
      'SELECT files FROM ws_messages WHERE session_id=?',
      'native',
    );
    const files: Array<{ id: string; name: string; mime?: string }> = JSON.parse(projected!.files);
    expect(files).toHaveLength(names.length);
    expect(new Set(files.map((file) => file.id)).size).toBe(names.length);
    const server = await startWorkspaceServer(service, 0, root);
    try {
      const base = `http://localhost:${server.port}`;
      const token = server.auth.issue('telegram:owner').split('#pair=')[1];
      const pairing = await fetch(`${base}/api/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      expect(pairing.status).toBe(200);
      const cookie = pairing.headers.get('set-cookie')!.split(';')[0];
      for (const [i, file] of files.entries()) {
        const response = await fetch(`${base}/api/files/${file.id}?inline=1`, { headers: { Cookie: cookie } });
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('image/png');
        expect(await response.text()).toBe(`image-${i}`);
      }
    } finally {
      await server.close();
    }
    expect(await routeOperatorMessage('native', 'telegram:owner', message)).toEqual({ queued: true, duplicate: true });
    expect(requestWake).toHaveBeenCalledTimes(1);
  } finally {
    await service.stop();
  }
});
