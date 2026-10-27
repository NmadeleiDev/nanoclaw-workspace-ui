import { resolveProviderName } from '../../providers/provider-name.js';
import { attachmentLimitError } from './attachment-limits.js';
import { AgentFiles } from './agent-files.js';
import { WorkspaceSkills, type SkillAgent } from './skills.js';
import { listModelConnections } from '../../model-connections.js';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { AnchoredDir } from '../../anchored-dir.js';
import { DATA_DIR, TIMEZONE } from '../../config.js';
import { readEnvFile } from '../../env.js';
import { withExistingMailboxSession, sessionDir, readOutboxFiles } from '../../session-manager.js';
import type { WorkspaceMailboxMessage, WorkspaceMailboxEvent } from '../../mailbox/types.js';
import { workspaceContext } from './context.js';
import { requireDirectories } from './directories.js';
import { WorkspaceStore } from './store.js';
import { WorkspaceNotifications } from './notifications.js';
import { UtilityModels } from './utility.js';
import type { WorkspaceBridge } from './bridge.js';
import { WorkspaceError, requiredText, type WorkspaceSession, type UtilityTask } from './types.js';

function safeJson(value: string): Record<string, any> {
  try {
    const object = JSON.parse(value);
    return object && typeof object === 'object' ? object : { text: value };
  } catch {
    return { text: value };
  }
}
const stamp = () => new Date().toISOString();
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export class WorkspaceService {
  readonly events = new EventEmitter();
  readonly models: UtilityModels;
  readonly notifications: WorkspaceNotifications;
  notificationOrigin: string | null = null;
  private timer?: ReturnType<typeof setInterval>;
  private controller = new AbortController();
  private ticking = false;
  private working = false;
  private documentsVersion = '';
  private operations = new Map<string, Promise<unknown>>();

  constructor(
    readonly store: WorkspaceStore,
    readonly bridge?: WorkspaceBridge,
    readonly filesRoot = path.join(DATA_DIR, 'workspace-files'),
  ) {
    this.models = new UtilityModels(bridge?.agentUtility);
    this.notifications = new WorkspaceNotifications(
      store,
      () => this.notificationOrigin,
      () => this.changed(),
    );
    this.events.setMaxListeners(100);
  }

  async start(): Promise<void> {
    await this.notifications.start();
    await this.store.db.run("UPDATE ws_utility_jobs SET state='pending' WHERE state='running'");
    await this.tick();
    this.timer = setInterval(() => {
      void this.tick().catch((error) => this.events.emit('notice', { error: String(error) }));
    }, 750);
  }

  async stop(): Promise<void> {
    this.controller.abort();
    if (this.timer) clearInterval(this.timer);
    while (this.ticking || this.working) await new Promise((resolve) => setTimeout(resolve, 25));
    await this.notifications.stop();
    this.events.removeAllListeners();
  }

  async exclusive<T>(id: string, run: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(id) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(run);
    this.operations.set(id, current);
    try {
      return await current;
    } finally {
      if (this.operations.get(id) === current) this.operations.delete(id);
    }
  }

  changed(): void {
    this.events.emit('change');
  }

  readonly skills = new WorkspaceSkills();
  readonly agentFiles = new AgentFiles();

  async workspaceAgent(id: string): Promise<SkillAgent> {
    const agent = await this.store.db.get<SkillAgent>(
      'SELECT a.id,a.name,a.folder,c.provider,c.skills FROM agent_groups a LEFT JOIN container_configs c ON c.agent_group_id=a.id WHERE a.id=?', id,
    );
    if (!agent) throw new WorkspaceError(404, 'Agent not found.');
    return agent;
  }

  async bootstrap() {
    const rows = await this.store.db.all<{id:string;name:string;folder:string;provider:string;model:string;effort:string}>(
      `SELECT a.id,a.name,a.folder,c.provider,c.model,c.effort FROM agent_groups a LEFT JOIN container_configs c ON c.agent_group_id=a.id ORDER BY a.created_at`,
    );
    const env = readEnvFile(['OPENCODE_PROVIDER', 'OPENCODE_BASE_URL', 'ANTHROPIC_BASE_URL']);
    const endpoint = process.env.OPENCODE_BASE_URL ?? env.OPENCODE_BASE_URL ?? process.env.ANTHROPIC_BASE_URL ?? env.ANTHROPIC_BASE_URL;
    let byteplus = false;
    try {
      const host = new URL(endpoint ?? '').hostname;
      byteplus = host === 'bytepluses.com' || host.endsWith('.bytepluses.com');
    } catch { /* Unconfigured endpoints retain the provider's model ID. */ }
    const connections = await listModelConnections();
    const agents = rows.map(row => {
      const agent={...row,provider:resolveProviderName(null,row.provider)};
      const connection=agent.provider==='opencode'?connections.find(c=>agent.model?.startsWith(c.id+'/')):undefined;
      return {...agent,modelProviders:Object.fromEntries(connections.map(c=>[c.id,c.name])),modelProvider:connection?{id:connection.id,label:connection.name}:agent.provider==='opencode'&&byteplus?{id:(process.env.OPENCODE_PROVIDER??env.OPENCODE_PROVIDER)||'anthropic',label:'BytePlus'}:null};
    });
    const runtime = await this.store.db.all('SELECT id,container_status,last_active,status FROM sessions');
    return {
      timezone: TIMEZONE,
      homeDirectory: os.homedir(),
      pending: await this.pending(),
      agents,
      modelConnections: connections,
      projects: await this.store.projects(),
      sessions: await this.store.sessions(),
      settings: await this.store.settings(),
      runtime,
      connected: !!this.bridge,
      documentVersions: Object.fromEntries(
        (
          await this.store.db.all<{ scope: string; scope_id: string; revision: number }>(
            'SELECT scope,scope_id,revision FROM ws_scratchpads',
          )
        ).map((d) => [`${d.scope}:${d.scope_id}`, d.revision]),
      ),
      jobs: await this.store.db.all(
        "SELECT id,scope_id,task,state,error,updated_at FROM ws_utility_jobs WHERE state!='completed' ORDER BY updated_at DESC LIMIT 100",
      ),
    };
  }

  async createSession(input: { agentId: string; projectId?: string | null; continuedFrom?: string; runtimeDriver?: string }) {
    if (!this.bridge)
      throw new WorkspaceError(503, 'This is an isolated preview. Chat becomes available after host activation.');
    const agentId = requiredText(input.agentId, 'Agent', 200);
    if (!(await this.store.db.get('SELECT id FROM agent_groups WHERE id=?', agentId)))
      throw new WorkspaceError(404, 'Agent not found.');
    const project = input.projectId ? await this.store.getProject(input.projectId) : null;
    if (project?.archived) throw new WorkspaceError(409, 'Restore the project before starting a session.');
    if (input.runtimeDriver && input.runtimeDriver !== 'docker') throw new WorkspaceError(400, 'This add-on supports Docker sessions.');
    const runtimeDriver = 'docker';
    const source = input.continuedFrom ? await this.store.getSession(input.continuedFrom) : null;
    const id = await this.bridge.create(agentId,runtimeDriver);
    const session = await this.store.addSession({
      id,
      nativeSessionId: id,
      agentId,
      projectId: project?.id ?? null,
      continuedFrom: source?.id,
      title: source ? `Continue: ${source.title}`.slice(0, 200) : undefined,
      directories: source?.directories ?? undefined,
      primaryDirectoryId: source?.primaryDirectoryId,
    });
    if (source) {
      const document = await this.store.document('session', source.id);
      const summary = document.markdown || (await this.generateSourceOverview(source));
      await this.store.saveDocument(
        'session',
        id,
        `## Continued from ${source.title}\n\n${summary}\n\nReference history: workspace_context can read imported conversation ${source.id}.`,
        0,
        'import-handoff',
      );
    }
    this.changed();
    return session;
  }

  async updateSession(id: string, input: Partial<WorkspaceSession>) {
    return this.exclusive(id, async () => {
      const old = await this.store.getSession(id);
      const runtimeChange = ['directories', 'primaryDirectoryId', 'model', 'effort'].some((key) => key in input);
      if ('runtimeDriver' in input) throw new WorkspaceError(400,'This add-on supports Docker sessions.');
      if (input.directories) requireDirectories(input.directories);
      // Validate the complete update before touching a running container.
      if (input.title !== undefined) requiredText(input.title, 'Session title', 200);
      for (const key of ['model', 'effort'] as const) if (input[key] != null) requiredText(input[key], key, 200);
      if (input.projectId) await this.store.getProject(input.projectId);
      if (
        input.primaryDirectoryId &&
        !(input.directories ?? old.directories).some((d) => d.id === input.primaryDirectoryId)
      )
        throw new WorkspaceError(400, 'Choose an attached working directory.');
      const validateModel=async()=>{
        if(input.model && old.nativeSessionId){
          const actual=await this.store.db.get<{provider:string}>("SELECT COALESCE(s.agent_provider,c.provider,'claude') AS provider FROM sessions s LEFT JOIN container_configs c ON c.agent_group_id=s.agent_group_id WHERE s.id=?",old.nativeSessionId);
          if(actual?.provider==='opencode'&&!(await listModelConnections()).some(c=>c.models.some(m=>`${c.id}/${m.id}`===input.model)))throw new WorkspaceError(400,'Add this model in Settings → API connections before selecting it.');
        }
      };
      await validateModel();
      if (runtimeChange && this.bridge) await this.bridge.reconfigure(old);
      const updated = await this.store.db.transaction(async()=>{
        await validateModel();
        return this.store.updateSession(id,input);
      });
      await this.syncContext(updated);
      this.changed();
      return updated;
    });
  }

  async send(
    id: string,
    ownerId: string,
    input: { id: string; text: string; attachments?: Array<{ name: string; data: string; mimeType?: string }> },
  ) {
    if (!this.bridge) throw new WorkspaceError(503, 'This preview does not send messages to your live agents.');
    return this.exclusive(id, async () => {
      const session = await this.store.getSession(id);
      if (!/^[a-zA-Z0-9_-]{8,120}$/.test(input.id)) throw new WorkspaceError(400, 'Invalid message id.');
      if (typeof input.text !== 'string' || input.text.length > 100_000)
        throw new WorkspaceError(400, 'Message is too long.');
      const attachments = input.attachments ?? [];
      if (!input.text.trim() && !attachments.length) throw new WorkspaceError(400, 'Write a message or attach a file.');
      if (
        !Array.isArray(attachments) ||
        attachments.length > 10 ||
        attachments.some(
          (f) =>
            !f ||
            typeof f.data !== 'string' ||
            f.data.length > 28_000_000 ||
            typeof f.name !== 'string' ||
            f.name.length > 240,
        )
      )
        throw new WorkspaceError(400, 'Attach at most 10 files, up to 20 MB each.');
      if (attachments.some((f) => f.data.length % 4 !== 0 || /[^A-Za-z0-9+/]/.test(f.data.replace(/={1,2}$/, ''))))
        throw new WorkspaceError(400, 'An attachment could not be read. Attach the file again.');
      const attachmentError = attachmentLimitError(
        attachments.map((f) => ({ name: f.name, size: Buffer.byteLength(f.data, 'base64') })),
      );
      if (attachmentError) throw new WorkspaceError(400, attachmentError);

      requireDirectories(session.directories);
      await this.syncContext(session);
      const requestDigest = digest(
        JSON.stringify({
          text: input.text,
          attachments: attachments.map((f) => ({ name: f.name, data: f.data, mimeType: f.mimeType })),
        }),
      );
      const content = JSON.stringify({
        _workspaceRequestDigest: requestDigest,
        text: input.text,
        sender: 'You · Web',
        senderId: ownerId,
        source: 'web',
        attachments,
      });
      const result = await this.bridge!.send(session, ownerId, `web-${input.id}`, content);
      await this.collect(session);
      this.changed();
      return result;
    });
  }

  async syncContext(session: WorkspaceSession): Promise<void> {
    if (!session.nativeSessionId || !this.bridge) return;
    const context = await workspaceContext(this.store, session.nativeSessionId);
    if (context)
      await withExistingMailboxSession(session.agentId, session.nativeSessionId, (box) =>
        box.setWorkspaceContext?.(context),
      );
  }

  async pending(sessionId?: string) {
    const approvals = await this.store.db.all<any>(
      `SELECT approval_id AS id,session_id,agent_group_id,title,question,options_json,status,approver_user_id,expires_at FROM pending_approvals WHERE status IN ('pending','awaiting_reason') ${sessionId ? 'AND session_id=?' : ''}`,
      ...(sessionId ? [sessionId] : []),
    );
    const questions = await this.store.db.all<any>(
      `SELECT question_id AS id,session_id,title,options_json FROM pending_questions ${sessionId ? 'WHERE session_id=?' : ''}`,
      ...(sessionId ? [sessionId] : []),
    );
    return [
      ...approvals.map((a) => ({ ...a, type: 'approval', options: JSON.parse(a.options_json || '[]') })),
      ...questions.map((q) => ({ ...q, type: 'question', options: JSON.parse(q.options_json || '[]') })),
    ];
  }

  async live(id: string) {
    const row = await this.store.db.get<{ value: string }>('SELECT value FROM ws_live WHERE session_id=?', id);
    return row ? JSON.parse(row.value) : null;
  }

  async tick(): Promise<void> {
    if (this.ticking || this.controller.signal.aborted) return;
    this.ticking = true;
    try {
      if (this.bridge) {
        const rows = await this.store.db.all<any>(
          "SELECT s.*,m.channel_type FROM sessions s LEFT JOIN messaging_groups m ON m.id=s.messaging_group_id WHERE s.thread_id IS NULL OR s.thread_id NOT LIKE 'system:%' OR s.thread_id LIKE 'system:workspace:%'",
        );
        for (const row of rows) {
          const old = await this.store.db.get('SELECT id FROM ws_sessions WHERE id=?', row.id);
          if (!old)
            await this.store.addSession({
              id: row.id,
              nativeSessionId: row.id,
              agentId: row.agent_group_id,
              title: row.channel_type
                ? `${row.channel_type[0].toUpperCase()}${row.channel_type.slice(1)} conversation`
                : 'Conversation',
              createdAt: row.created_at,
            });
          await this.collect(await this.store.getSession(row.id));
        }
      }
      const pending = await this.pending();
      await this.notifications.requests(pending);
      // Network retries must not stall collection or chat updates.
      void this.notifications.dispatch(pending).catch((error) => this.events.emit('notice', { error: String(error) }));
      const docs = await this.store.db.get<{ version: string }>(
        'SELECT MAX(updated_at) AS version FROM ws_scratchpads',
      );
      if (docs?.version !== this.documentsVersion) {
        this.documentsVersion = docs?.version ?? '';
        this.changed();
      }
      if (!this.working) void this.work().catch((error) => this.events.emit('notice', { error: String(error) }));
    } finally {
      this.ticking = false;
    }
  }

  async collect(session: WorkspaceSession): Promise<void> {
    if (!session.nativeSessionId) return;
    const cursors = await this.store.db.all<{ direction: string; cursor: number }>(
      'SELECT direction,cursor FROM ws_cursors WHERE session_id=?',
      session.id,
    );
    const cursor = Object.fromEntries(cursors.map((c) => [c.direction, c.cursor]));
    const notificationCursor =
      (
        await this.store.db.get<{ cursor: number }>(
          'SELECT cursor FROM ws_notification_cursors WHERE session_id=?',
          session.id,
        )
      )?.cursor ?? 0;
    const batch = await withExistingMailboxSession(session.agentId, session.nativeSessionId, (box) => ({
      incoming: box.getWorkspaceInbound?.(cursor.in ?? -1, 200) ?? [],
      outgoing: box.getWorkspaceOutbound?.(cursor.out ?? -1, 200) ?? [],
      events: box.getWorkspaceEvents?.(Math.min(cursor.event ?? 0, notificationCursor), 500) ?? [],
    }));
    if (!batch) return;
    let changed = false;
    for (const [direction, rows] of [
      ['in', batch.incoming],
      ['out', batch.outgoing],
    ] as const) {
      for (const row of rows) {
        if (['chat', 'chat-sdk', 'file'].includes(row.kind) && row.channel_type !== 'session-echo') {
          const content = safeJson(row.content);
          const files = await this.registerNativeFiles(session, row, content, direction);
          const text =
            typeof content.text === 'string'
              ? content.text
              : content.type === 'ask_question'
                ? String(content.question || content.title || '')
                : '';
          const added = await this.store.putMessage({
            id: `${session.id}:${direction}:${row.id}`,
            sessionId: session.id,
            role: direction === 'in' ? 'user' : 'assistant',
            kind: row.kind,
            text,
            timestamp: row.timestamp,
            source: content.source === 'web' ? 'web' : (row.channel_type ?? 'agent'),
            files,
            data: {
              ...(direction === 'out' ? { outboundSeq: row.seq, channelType: row.channel_type } : {}),
              ...(typeof content.sender === 'string' ? { sender: content.sender } : {}),
              ...(content.type === 'ask_question' ? { questionId: content.questionId, title: content.title } : {}),
            },
          });
          changed ||= added;
          if (added && direction === 'out' && text && content.type !== 'ask_question' && !content.failureNotice) {
            const key = `${row.timestamp}|${session.id}:${direction}:${row.id}`;
            await this.enqueue(session.id, 'session-summary', key, 10_000);
            if (!session.customTitle) await this.enqueue(session.id, 'title', key, 1000);
          }
        }
      }
      if (rows.length) await this.setCursor(session.id, direction, rows[rows.length - 1].seq);
    }
    if (batch.events.length) {
      await this.applyEvents(
        session.id,
        batch.events.filter((e) => e.seq > (cursor.event ?? 0)),
      );
      await this.setCursor(session.id, 'event', batch.events[batch.events.length - 1].seq);
      changed = true;
    }
    for (const event of batch.events.filter((e) => e.seq > notificationCursor)) {
      if (event.kind === 'turn-finished') {
        const data = safeJson(event.content);
        const latestOut = batch.outgoing.at(-1)?.seq ?? cursor.out ?? -1;
        const ranges = Array.isArray(data.ranges) ? data.ranges : [];
        if (ranges.some((r: any) => r.upto > latestOut)) break;
        const messages = await this.store.db.all<{ id: string; text: string; data: string }>(
          'SELECT id,text,data FROM ws_messages WHERE session_id=? AND role=? ORDER BY timestamp,id',
          session.id,
          'assistant',
        );
        const matching = messages.filter((m) => {
          const meta = safeJson(m.data);
          return (
            meta.channelType === 'workspace' &&
            ranges.some((r: any) => meta.outboundSeq > r.after && meta.outboundSeq <= r.upto)
          );
        });
        const reply = matching
          .map((m) => m.text)
          .filter(Boolean)
          .join('\n');
        if (data.failed || reply)
          await this.notifications.record(
            session,
            data.failed ? 'failure' : 'reply',
            data.failed ? 'The agent could not finish this turn. Open the session for details.' : reply,
            `turn:${session.id}:${data.id}`,
            event.timestamp,
            null,
            undefined,
            matching.at(-1)?.id,
          );
      }
      await this.store.db.run(
        'INSERT INTO ws_notification_cursors (session_id,cursor) VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET cursor=excluded.cursor',
        session.id,
        event.seq,
      );
    }
    if (changed) this.changed();
  }

  private async setCursor(id: string, direction: string, cursor: number): Promise<void> {
    await this.store.db.run(
      'INSERT INTO ws_cursors (session_id,direction,cursor) VALUES (?,?,?) ON CONFLICT(session_id,direction) DO UPDATE SET cursor=excluded.cursor',
      id,
      direction,
      cursor,
    );
  }

  private async registerNativeFiles(
    session: WorkspaceSession,
    row: WorkspaceMailboxMessage,
    content: Record<string, any>,
    direction: 'in' | 'out',
  ) {
    const attachments: Array<{ name: string; id: string; mime?: string }> = [];
    const candidates =
      direction === 'in'
        ? Array.isArray(content.attachments)
          ? content.attachments
          : []
        : Array.isArray(content.files)
          ? content.files.map((name: string) => ({ name, localPath: `outbox/${row.id}/${name}` }))
          : [];
    for (const file of candidates) {
      if (typeof file.name !== 'string' || path.basename(file.name) !== file.name) continue;
      let relative = file.localPath;
      if (typeof relative !== 'string') continue;
      if (relative.startsWith('/workspace/')) relative = relative.slice('/workspace/'.length);
      if (path.isAbsolute(relative) && relative.startsWith(sessionDir(session.agentId, session.id) + path.sep))
        relative = path.relative(sessionDir(session.agentId, session.id), relative);
      if (path.isAbsolute(relative) || relative.split('/').some((p: string) => p === '..' || !p)) continue;
      const id = digest(`${session.id}:${row.id}:${file.name}`).slice(0, 32);
      await this.store.db.run(
        'INSERT INTO ws_files (id,session_id,filename,path,mime) VALUES (?,?,?,?,?) ON CONFLICT(id) DO NOTHING',
        id,
        session.id,
        file.name,
        relative,
        file.mimeType ?? null,
      );
      attachments.push({ id, name: file.name, mime: file.mimeType });
    }
    return attachments;
  }

  async captureOutboundFiles(sessionId: string, messageId: string, raw: string): Promise<void> {
    const content = safeJson(raw);
    if (!Array.isArray(content.files) || !content.files.length) return;
    const session = await this.store.getSession(sessionId);
    const files = readOutboxFiles(session.agentId, session.id, messageId, content.files);
    for (const file of files ?? []) {
      const id = digest(`${session.id}:${messageId}:${file.filename}`).slice(0, 32);
      const folder = path.join(this.filesRoot, session.id);
      fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
      const destination = path.join(folder, id);
      if (!fs.existsSync(destination)) fs.writeFileSync(destination, file.data, { mode: 0o600, flag: 'wx' });
      const mime =
        (
          {
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.webp': 'image/webp',
            '.gif': 'image/gif',
            '.pdf': 'application/pdf',
            '.txt': 'text/plain',
          } as Record<string, string>
        )[path.extname(file.filename).toLowerCase()] ?? 'application/octet-stream';
      await this.store.db.run(
        'INSERT INTO ws_files (id,session_id,filename,path,mime) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET path=excluded.path,mime=excluded.mime',
        id,
        session.id,
        file.filename,
        `owned:${session.id}/${id}`,
        mime,
      );
    }
  }

  async file(id: string): Promise<{ name: string; mime: string; data: Buffer }> {
    const file = await this.store.db.get<any>('SELECT * FROM ws_files WHERE id=?', id);
    if (!file) throw new WorkspaceError(404, 'Attachment not found.');
    const session = await this.store.getSession(file.session_id);
    const segments = String(file.path).split('/');
    if (segments.some((s) => !s || s === '..' || s === '.')) throw new WorkspaceError(403, 'Invalid attachment path.');
    const owned = String(file.path).startsWith('owned:');
    if (owned) segments[0] = segments[0].slice('owned:'.length);
    const root = session.origin === 'openclaw' || owned ? this.filesRoot : path.join(DATA_DIR, 'v2-sessions');
    const directories =
      session.origin === 'openclaw' || owned
        ? segments.slice(0, -1)
        : [session.agentId, session.id, ...segments.slice(0, -1)];
    const dir = AnchoredDir.open(root, directories);
    if (!dir) throw new WorkspaceError(404, 'The attachment is no longer available.');
    try {
      return {
        name: file.filename,
        mime: file.mime || 'application/octet-stream',
        data: dir.readFile(segments[segments.length - 1]),
      };
    } finally {
      dir.close();
    }
  }

  private async applyEvents(id: string, rows: WorkspaceMailboxEvent[]) {
    let live = (await this.live(id)) ?? { running: false, tools: {}, texts: {} };
    for (const row of rows) {
      const data = safeJson(row.content);
      if (row.kind === 'turn-start') live = { running: true, startedAt: row.timestamp, tools: {}, texts: {} };
      else if (row.kind === 'text-delta')
        live.texts[data.id] = `${live.texts[data.id] ?? ''}${data.delta ?? ''}`.slice(-100_000);
      else if (row.kind === 'tool') live.tools[data.id] = { ...live.tools[data.id], ...data };
      else if (row.kind === 'turn-error') {
        live.error = data.message;
        live.running = false;
      } else if (row.kind === 'turn-result' || row.kind === 'turn-cancelled') {
        live.running = false;
        live.texts = {};
      }
      live.updatedAt = row.timestamp;
    }
    await this.store.db.run(
      'INSERT INTO ws_live (session_id,value) VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET value=excluded.value',
      id,
      JSON.stringify(live),
    );
  }

  async enqueue(scopeId: string, task: UtilityTask, sourceKey: string = randomUUID(), delayMs = 0): Promise<void> {
    const settings = await this.store.settings();
    if (!settings.automaticSummaries && delayMs > 0) return;
    const id = `${task}:${scopeId}`;
    await this.store.db.run(
      `INSERT INTO ws_utility_jobs (id,scope_id,task,source_key,state,due_at,attempts,error,updated_at)
      VALUES (?,?,?,?,'pending',?,0,NULL,?) ON CONFLICT(id) DO UPDATE SET source_key=excluded.source_key,state='pending',
      due_at=excluded.due_at,attempts=0,error=NULL,updated_at=excluded.updated_at WHERE ws_utility_jobs.source_key != excluded.source_key`,
      id,
      scopeId,
      task,
      sourceKey,
      new Date(Date.now() + delayMs).toISOString(),
      stamp(),
    );
    this.changed();
  }

  async work(): Promise<void> {
    if (this.working || this.controller.signal.aborted) return;
    this.working = true;
    try {
      const job = await this.store.db.get<any>(
        "SELECT * FROM ws_utility_jobs WHERE state='pending' AND due_at<=? ORDER BY due_at LIMIT 1",
        stamp(),
      );
      if (!job) return;
      const claimed = await this.store.db.run(
        "UPDATE ws_utility_jobs SET state='running',updated_at=? WHERE id=? AND state='pending' AND source_key=?",
        stamp(),
        job.id,
        job.source_key,
      );
      if (!claimed.changes) return;
      this.changed();
      try {
        const settings = await this.store.settings();
        const task = job.task as UtilityTask;
        const scope = task === 'project-summary' ? 'project' : 'session';
        const current = task === 'title' ? null : await this.store.document(scope, job.scope_id);
        let agentId = settings.maintenanceAgentId ?? undefined;
        let evidence: string;
        let summaryCursor: string | undefined;
        if (scope === 'project') {
          const p = await this.store.getProject(job.scope_id);
          const sessions = (await this.store.sessions()).filter((s) => s.projectId === p.id);
          agentId ??= sessions[0]?.agentId;
          const docs = [];
          for (const s of sessions)
            docs.push(`## ${s.title} (${s.agentId})\n${(await this.store.document('session', s.id)).markdown}`);
          evidence = `${p.description}\n\n${docs.join('\n\n')}`;
        } else {
          const s = await this.store.getSession(job.scope_id);
          agentId = s.agentId;
          const watermark =
            task === 'title' || !job.source_key.includes('|')
              ? undefined
              : await this.store.db.get<{ value: string }>(
                  'SELECT value FROM ws_settings WHERE id=?',
                  `summary-cursor:${s.id}`,
                );
          const messages = await this.store.db.all<any>(
            `SELECT role,text,timestamp,id FROM ws_messages WHERE session_id=? AND role IN ('user','assistant') ${watermark ? "AND (timestamp || '|' || id)>?" : ''} ${job.source_key.includes('|') ? "AND (timestamp || '|' || id)<=?" : ''} ORDER BY timestamp,id`,
            s.id,
            ...(watermark ? [watermark.value] : []),
            ...(job.source_key.includes('|') ? [job.source_key] : []),
          );
          evidence = messages.map((m) => `[${m.timestamp} ${m.role}] ${m.text}`).join('\n\n');
          if (!evidence) {
            await this.store.db.run(
              "UPDATE ws_utility_jobs SET state='completed',error=NULL WHERE id=? AND source_key=?",
              job.id,
              job.source_key,
            );
            return;
          }
          const last = messages[messages.length - 1];
          summaryCursor = `${last.timestamp}|${last.id}`;
        }
        const profile = settings.overrides[task] ?? settings.utility;
        const result = await this.models.run(profile, {
          task,
          text: evidence,
          current: current?.markdown ?? '',
          agentId,
          signal: this.controller.signal,
        });
        const fresh = await this.store.db.get<any>('SELECT source_key,state FROM ws_utility_jobs WHERE id=?', job.id);
        if (fresh?.source_key !== job.source_key || fresh.state !== 'running') return;
        if (task === 'title') await this.store.updateSession(job.scope_id, { title: result }, true);
        else {
          await this.store.saveDocument(scope, job.scope_id, result, current!.revision, `utility:${profile.provider}`);
          if (scope === 'session') {
            await this.store.db.run(
              'INSERT INTO ws_settings (id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',
              `summary-cursor:${job.scope_id}`,
              summaryCursor!,
            );
            const s = await this.store.getSession(job.scope_id);
            await this.syncContext(s);
            if (s.projectId)
              await this.enqueue(s.projectId, 'project-summary', `${job.scope_id}:${current!.revision + 1}`, 30_000);
          } else
            for (const s of (await this.store.sessions()).filter((s) => s.projectId === job.scope_id))
              await this.syncContext(s);
        }
        await this.store.db.run(
          "UPDATE ws_utility_jobs SET state='completed',error=NULL,updated_at=? WHERE id=? AND source_key=?",
          stamp(),
          job.id,
          job.source_key,
        );
      } catch (error) {
        const conflict = error instanceof WorkspaceError && error.status === 409;
        const attempts = job.attempts + 1;
        await this.store.db.run(
          'UPDATE ws_utility_jobs SET state=?,attempts=?,error=?,due_at=?,updated_at=? WHERE id=? AND source_key=?',
          conflict || attempts < 3 ? 'pending' : 'failed',
          attempts,
          error instanceof Error ? error.message : String(error),
          new Date(Date.now() + (conflict ? 10_000 : 30_000 * attempts)).toISOString(),
          stamp(),
          job.id,
          job.source_key,
        );
      }
      this.changed();
    } finally {
      this.working = false;
    }
  }

  private async generateSourceOverview(source: WorkspaceSession): Promise<string> {
    const settings = await this.store.settings();
    const rows = await this.store.db.all<any>(
      "SELECT role,text FROM ws_messages WHERE session_id=? AND role IN ('user','assistant') ORDER BY timestamp,id",
      source.id,
    );
    if (!rows.length)
      return 'No textual messages were available in the imported conversation. Read its reference history before proceeding.';
    return this.models.run(settings.overrides['session-summary'] ?? settings.utility, {
      task: 'session-summary',
      current: '',
      text: rows.map((r) => `${r.role}: ${r.text}`).join('\n\n'),
      agentId: source.agentId,
      signal: this.controller.signal,
    });
  }
}
