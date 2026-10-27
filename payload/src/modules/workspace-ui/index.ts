import './migration.js';
import './context-action.js';
import { randomUUID } from 'node:crypto';
import { onHostStart, onHostShutdown } from '../../host-lifecycle.js';
import { getDb } from '../../db/connection.js';
import { register } from '../../cli/registry.js';
import { registerChannelAdapter } from '../../channels/channel-registry.js';
import { registerSessionWorkspace } from '../../session-workspace.js';
import { registerDeliveryBatchPreview } from '../../delivery.js';
import { log } from '../../log.js';
import { WorkspaceStore } from './store.js';
import { WorkspaceService } from './service.js';
import { workspaceConfiguration, workspaceContext } from './context.js';
import { hostBridge } from './bridge.js';
import { startWorkspaceServer } from './server.js';

let service: WorkspaceService | undefined;
let server: Awaited<ReturnType<typeof startWorkspaceServer>> | undefined;
let startupError: string | undefined;
let hostReady = false;

registerDeliveryBatchPreview(async (batch, session) => {
  if (!service || session.thread_id === 'system:workspace-utilities') return;
  await service.store.addSession({ id: session.id, nativeSessionId: session.id, agentId: session.agent_group_id });
  for (const message of batch) await service.captureOutboundFiles(session.id, message.id, message.content);
});

registerSessionWorkspace({
  async configure(session, base) {
    const db = getDb();
    return (await db.hasTable('ws_sessions')) ? workspaceConfiguration(new WorkspaceStore(db), session, base) : base;
  },
  async context(id) {
    const db = getDb();
    return (await db.hasTable('ws_sessions')) ? workspaceContext(new WorkspaceStore(db), id) : undefined;
  },
});

const defaults = {
  dm: {
    engageMode: 'pattern' as const,
    engagePattern: '.',
    threads: true,
    sessionMode: 'per-thread' as const,
    unknownSenderPolicy: 'strict' as const,
  },
  group: {
    engageMode: 'pattern' as const,
    engagePattern: '.',
    threads: true,
    sessionMode: 'per-thread' as const,
    unknownSenderPolicy: 'strict' as const,
  },
  mentions: 'never' as const,
};

registerChannelAdapter('workspace', {
  defaults,
  factory: () => ({
    name: 'workspace',
    channelType: 'workspace',
    supportsThreads: true,
    defaults,
    async setup() {},
    async teardown() {},
    isConnected: () => !!server,
    async deliver() {
      if (!server) throw new Error(startupError ?? 'Workspace is not enabled.');
      service?.changed();
      // The runner's outbound record is the canonical delivered message; the web collector projects it once.
      return `workspace-${randomUUID()}`;
    },
  }),
});

async function start(): Promise<void> {
  if (server || !hostReady) return;
  const store = new WorkspaceStore(getDb());
  const settings = await store.settings();
  if (!settings.enabled) return;
  service = new WorkspaceService(store, hostBridge());
  try {
    server = await startWorkspaceServer(service, settings.port);
    await service.start();
    startupError = undefined;
    log.info('Workspace listening', { url: `http://localhost:${settings.port}` });
  } catch (error) {
    startupError = error instanceof Error ? error.message : String(error);
    await service.stop();
    await server?.close();
    server = undefined;
    service = undefined;
    // An optional UI port must not take down the user's messaging agents.
    log.error('Workspace could not start; messaging agents remain available', { error: startupError });
  }
}

onHostStart(async () => {
  hostReady = true;
  await start();
});
onHostShutdown(async () => {
  hostReady = false;
  await server?.close();
  await service?.stop();
  server = undefined;
  service = undefined;
});

register({
  name: 'workspace-open',
  resource: 'workspace',
  access: 'open',
  hostOnly: true,
  description:
    'Pair this browser with the local workspace. --owner selects an existing owner identity. --tailnet issues an HTTPS device pairing link.',
  parseArgs: (args) => args,
  async handler(args) {
    if (!server) throw new Error(startupError ?? 'Workspace is disabled. Run ncl workspace enable first.');
    const owners = await getDb().all<{ user_id: string }>(
      "SELECT user_id FROM user_roles WHERE role='owner' AND agent_group_id IS NULL ORDER BY granted_at",
    );
    const ownerId = typeof args.owner === 'string' ? args.owner : owners[0]?.user_id;
    if (!ownerId || !owners.some((owner) => owner.user_id === ownerId))
      throw new Error('Choose an existing owner identity with --owner.');
    const url = server.auth.issue(ownerId, args.tailnet === true ? server.tailnet.url() : undefined);
    return {
      url,
      code: server.auth.codeFor(url),
      expiresInSeconds: 120,
      codeExpiresInSeconds: 600,
    };
  },
  formatHuman: (data) => (data as { url: string }).url,
});

register({
  name: 'workspace-enable',
  resource: 'workspace',
  access: 'open',
  hostOnly: true,
  description: 'Enable the localhost workspace. Optional --port (default 3210). Does not change agent settings.',
  parseArgs: (args) => args,
  async handler(args) {
    const store = new WorkspaceStore(getDb());
    const settings = await store.saveSettings({
      enabled: true,
      ...(args.port !== undefined ? { port: Number(args.port) } : {}),
    });
    await start();
    if (startupError) throw new Error(startupError);
    return { enabled: true, port: settings.port, running: !!server, next: 'ncl workspace open' };
  },
});

register({
  name: 'workspace-status',
  resource: 'workspace',
  access: 'open',
  hostOnly: true,
  description: 'Inspect workspace availability and configuration.',
  parseArgs: (args) => args,
  handler: async () => ({
    settings: await new WorkspaceStore(getDb()).settings(),
    running: !!server,
    error: startupError ?? null,
  }),
});

register({
  name: 'workspace-tailnet',
  resource: 'workspace',
  access: 'open',
  hostOnly: true,
  description: 'Inspect private HTTPS access, or change it with --enable / --disable.',
  parseArgs: (args) => args,
  async handler(args) {
    if (!server) throw new Error('Enable the workspace first.');
    if (args.enable && args.disable) throw new Error('Choose --enable or --disable.');
    if (args.enable === true) return server.tailnet.setEnabled(true);
    if (args.disable === true) return server.tailnet.setEnabled(false);
    return server.tailnet.status();
  },
});
