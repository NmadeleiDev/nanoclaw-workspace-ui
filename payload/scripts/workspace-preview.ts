/** Isolated localhost review: copy state, never attach to the running host's mailboxes. */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { readEnvFile } from '../src/env.js';

const projectRoot = process.cwd();
// Preserve the source install’s gateway selection without copying its secrets.
const gatewayProvider = readEnvFile(['NANOCLAW_GATEWAY_PROVIDER'], projectRoot).NANOCLAW_GATEWAY_PROVIDER;
if (gatewayProvider && !process.env.NANOCLAW_GATEWAY_PROVIDER) process.env.NANOCLAW_GATEWAY_PROVIDER = gatewayProvider;

const resume = process.env.WORKSPACE_PREVIEW_RESUME;
const previewRoot = resume
  ? path.resolve(projectRoot, resume)
  : fs.mkdtempSync(path.join(projectRoot, '.workspace-preview-'));
if (path.dirname(previewRoot) !== projectRoot || !path.basename(previewRoot).startsWith('.workspace-preview-'))
  throw new Error('Resume must name an isolated preview inside this project.');
fs.chmodSync(previewRoot, 0o700);
fs.mkdirSync(path.join(previewRoot, 'data'), { mode: 0o700, recursive: true });
let nativeSessions: Array<{ id: string; agent_group_id: string }> = [];
if (!resume) {
  const source = new Database(path.join(projectRoot, 'data', 'v2.db'), { readonly: true, fileMustExist: true });
  nativeSessions = source.prepare('SELECT id,agent_group_id FROM sessions').all() as Array<{
    id: string;
    agent_group_id: string;
  }>;
  await source.backup(path.join(previewRoot, 'data', 'v2.db'));
  source.close();
  for (const session of nativeSessions) {
    const relative = path.join('data', 'v2-sessions', session.agent_group_id, session.id);
    const target = path.join(previewRoot, relative);
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    for (const side of ['inbound', 'outbound']) {
      const file = path.join(projectRoot, relative, `${side}.db`);
      if (!fs.existsSync(file)) continue;
      const mailbox = new Database(file, { readonly: true, fileMustExist: true });
      try {
        await mailbox.backup(path.join(target, `${side}.db`));
      } finally {
        mailbox.close();
      }
    }
    for (const folder of ['inbox', 'outbox']) {
      const file = path.join(projectRoot, relative, folder);
      if (fs.existsSync(file))
        fs.cpSync(file, path.join(target, folder), {
          recursive: true,
          dereference: false,
          filter: (entry) => !fs.lstatSync(entry).isSymbolicLink(),
        });
    }
  }
}

// Retained attachments live independently of per-session outboxes.
if (!resume && fs.existsSync(path.join(projectRoot,'data/workspace-files'))) {
 fs.cpSync(path.join(projectRoot,'data/workspace-files'),path.join(previewRoot,'data/workspace-files'),{recursive:true,dereference:false,filter:entry=>!fs.lstatSync(entry).isSymbolicLink()});
}

// Config constants resolve only after changing cwd to the isolated install root.
process.chdir(previewRoot);
const { initDb, closeDb } = await import('../src/db/connection.js');
const { runMigrations } = await import('../src/db/migrations/index.js');
await import('../src/modules/workspace-ui/migration.js');
await import('../src/mailbox/compose.js');
const { WorkspaceStore } = await import('../src/modules/workspace-ui/store.js');
const { WorkspaceService } = await import('../src/modules/workspace-ui/service.js');
const { startWorkspaceServer } = await import('../src/modules/workspace-ui/server.js');
const { UtilityModels } = await import('../src/modules/workspace-ui/utility.js');
const db = await initDb(path.join(previewRoot, 'data', 'v2.db'), { role: 'tool' });
await runMigrations(db, undefined, { mode: 'migrate' });
const store = new WorkspaceStore(db);
if (!resume) {
  const { snapshotAgentSkills } = await import('../src/modules/workspace-ui/skill-snapshot.js');
  const agents = await db.all<import('../src/modules/workspace-ui/skills.js').SkillAgent>(
    'SELECT a.id,a.name,a.folder,c.provider,c.skills FROM agent_groups a LEFT JOIN container_configs c ON c.agent_group_id=a.id',
  );
  for (const warning of snapshotAgentSkills(agents, projectRoot, previewRoot)) console.warn(warning);
  const { snapshotAgentFiles } = await import('../src/modules/workspace-ui/agent-files.js');
  for (const warning of snapshotAgentFiles(agents, projectRoot, previewRoot)) console.warn(warning);
}

await store.saveSettings({ automaticSummaries: false });
const service = new WorkspaceService(store, undefined, path.join(previewRoot, 'data', 'workspace-files'));
// The preview uses the built native helper without copying or changing it.
Object.defineProperty(service, 'models', {
  value: new UtilityModels(undefined, path.join(projectRoot, 'dist', 'workspace-native', 'apple-model')),
});
for (const row of nativeSessions) {
  const session = await store.addSession({
    id: row.id,
    nativeSessionId: row.id,
    agentId: row.agent_group_id,
    title: 'Telegram conversation',
  });
  await service.collect(session);
}
await db.run('DELETE FROM ws_utility_jobs');
const port = Number(process.env.WORKSPACE_PREVIEW_PORT || '3211');
const server = await startWorkspaceServer(service, port, path.join(projectRoot, 'web', 'workspace', 'dist'));
await service.start();
const owner = await db.get<{ user_id: string }>("SELECT user_id FROM user_roles WHERE role='owner' LIMIT 1");
if (!owner) throw new Error('No owner identity was available in the copied state.');
const writePairing = () =>
  fs.writeFileSync(
    path.join(previewRoot, 'preview.json'),
    JSON.stringify({ root: previewRoot, port, url: server.auth.issue(owner.user_id) }),
    { mode: 0o600 },
  );
writePairing();
const pairingTimer = setInterval(writePairing, 60_000);
console.log(`Isolated preview: ${server.auth.issue(owner.user_id)}`);
console.log(`Preview data: ${previewRoot}`);
console.log('Live agents and OpenClaw are unchanged. Press Ctrl+C to stop.');
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  clearInterval(pairingTimer);
  await server.close();
  await service.stop();
  await closeDb();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
