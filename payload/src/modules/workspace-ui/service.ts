import { resolveProviderName } from '../../providers/provider-name.js';
import { reduceTimeline } from './timeline.js';
import type { RuntimeEnded } from '../../host-lifecycle.js';
import {parseContextUsage} from './context-usage.js';
import { activitySources, sameActivityEvidence, isToolOnly, liveActivityKey, type ActivityMessage } from './activity.js';
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
import { WorkspaceNotifications, plainPreview } from './notifications.js';
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
    const placeholders = await this.store.db.all<{id:string}>("SELECT id FROM ws_sessions WHERE title='New conversation' AND custom_title=0 AND origin<>'openclaw'");
    for (const session of placeholders) await this.store.seedMessageTitle(session.id);
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
      const agent = { ...row, provider: resolveProviderName(null, row.provider) };
      const connection=agent.provider==='opencode'?connections.find(c=>agent.model?.startsWith(c.id+'/')):undefined;
      return {...agent,modelProviders:Object.fromEntries(connections.map(c=>[c.id,c.name])),modelProvider:connection?{id:connection.id,label:connection.name}:agent.provider==='opencode'&&byteplus?{id:(process.env.OPENCODE_PROVIDER??env.OPENCODE_PROVIDER)||'anthropic',label:'BytePlus'}:null};
    });
    const runtime = await this.store.db.all<{ id: string; container_status: string; status: string; last_active: string | null }>('SELECT id,container_status,last_active,status FROM sessions');
    const pending = await this.pending();
    const waitingSessions = new Set(pending.filter(request =>
      request.type === 'question' || ['pending', 'awaiting_reason'].includes(request.status),
    ).map(request => request.session_id));
    const activity = new Map((await this.store.db.all<{ session_id: string; value: string }>(
      'SELECT session_id,value FROM ws_live',
    )).map(row => [row.session_id, safeJson(row.value)]));
    const activeRuntimes = new Set(runtime.filter(row =>
      row.status === 'active' && ['running', 'idle'].includes(row.container_status),
    ).map(row => row.id));
    const previews = await this.store.db.all<{ session_id: string; role: 'user' | 'assistant' | null; text: string | null; source: string | null; data: string; files: string | null; timestamp: string | null }>(
      `SELECT s.id AS session_id,m.role,substr(m.text,1,2000) AS text,m.source,
       CASE WHEN m.role='user' THEN m.data ELSE '{}' END AS data,m.files,m.timestamp
       FROM ws_sessions s LEFT JOIN ws_messages m ON m.id=(
         SELECT id FROM ws_messages WHERE session_id=s.id AND role IN ('user','assistant')
         AND kind IN ('chat','chat-sdk','file') AND (trim(replace(replace(replace(text,?,''),?,''),?,''))<>'' OR files<>'[]')
         ORDER BY timestamp DESC,id DESC LIMIT 1
       )`, '\t', '\r', '\n',
    );
    const latestMessages = new Map(previews.map(row => {
      const sender = safeJson(row.data).sender;
      return [row.session_id, row.role ? {
        role: row.role,
        text: plainPreview(row.text ?? '') || (row.files && row.files !== '[]' ? 'Attachment' : 'Message'),
        sender: row.role === 'user' ? (row.source === 'web' ? 'You' : typeof sender === 'string' ? plainPreview(sender) : 'You') : null,
        timestamp: row.timestamp,
      } : null] as const;
    }));
    return {
      timezone: TIMEZONE,
      homeDirectory: os.homedir(),
      pending,
      agents,
      modelConnections: connections,
      projects: await this.store.projects(),
      sessions: (await this.store.sessions()).map(session => ({
        ...session,
        working: !!session.nativeSessionId && activeRuntimes.has(session.nativeSessionId) &&
          !waitingSessions.has(session.nativeSessionId) && activity.get(session.id)?.running === true &&
          !activity.get(session.id)?.waiting,
        latestMessage: latestMessages.get(session.id) ?? null,
      })),
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
      const runtimeChange = ['projectId', 'directories', 'primaryDirectoryId', 'model', 'effort'].some((key) => key in input);
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
        sender: 'You',
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
      `SELECT approval_id AS id,session_id,agent_group_id,title,question,options_json,status,application_state,approver_user_id,CASE WHEN status='awaiting_reason' THEN reason_deadline_at ELSE expires_at END AS expires_at FROM pending_approvals WHERE (status IN ('pending','awaiting_reason','expired') OR (status='approved' AND application_state='applying' AND archived_at IS NULL)) AND NOT EXISTS (SELECT 1 FROM ws_dismissed_requests d WHERE d.request_id=pending_approvals.approval_id) ${sessionId ? 'AND session_id=?' : ''}`,
      ...(sessionId ? [sessionId] : []),
    );
    const questions = await this.store.db.all<any>(
      `SELECT question_id AS id,session_id,title,options_json FROM pending_questions ${sessionId ? 'WHERE session_id=?' : ''}`,
      ...(sessionId ? [sessionId] : []),
    );
    return [
      ...approvals.map((a) => ({ ...a, status: a.expires_at && Date.parse(a.expires_at) <= Date.now() ? 'expired' : a.status, type: 'approval', options: JSON.parse(a.options_json || '[]') })),
      ...questions.map((q) => ({ ...q, type: 'question', options: JSON.parse(q.options_json || '[]') })),
    ];
  }

  async dismissExpiredRequest(id: string) {
    await this.store.db.transaction(async()=>{
      const row = await this.store.db.get<any>('SELECT expires_at,status FROM pending_approvals WHERE approval_id=?',id);
      if (!row) throw new WorkspaceError(404,'Approval request not found.');
      if (!(row.expires_at && Date.parse(row.expires_at) <= Date.now()))
        throw new WorkspaceError(409,'Only expired approval requests can be dismissed.');
      await this.store.db.run('INSERT INTO ws_dismissed_requests (request_id,dismissed_at) VALUES (?,?) ON CONFLICT(request_id) DO NOTHING',id,stamp());
    });
    this.changed();
    return {dismissed:true};
  }

  async live(id: string) {
    const row = await this.store.db.get<{ value: string }>('SELECT value FROM ws_live WHERE session_id=?', id);
    if (!row) return null;
    const live = JSON.parse(row.value);
    if (!live.running && live.startedAt) {
      const archived = await this.store.db.get('SELECT id FROM ws_messages WHERE session_id=? AND id=?',id,`${id}:${liveActivityKey(live)}`);
      if (archived) live.archived = true;
    }
    return live;
  }

  async tick(): Promise<void> {
    if (this.ticking || this.controller.signal.aborted) return;
    this.ticking = true;
    try {
      if (this.bridge) {
        const rows = await this.store.db.all<any>(
          "SELECT s.*,m.channel_type FROM sessions s LEFT JOIN messaging_groups m ON m.id=s.messaging_group_id WHERE s.thread_id IS NULL OR s.thread_id NOT LIKE 'system:%' OR s.thread_id LIKE 'system:workspace:%' OR s.thread_id LIKE 'system:tasks:%'",
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

  async collect(session: WorkspaceSession, ended?: RuntimeEnded): Promise<void> {
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
    const activityCursor = await this.store.db.get<{cursor:number;value:string}>('SELECT cursor,value FROM ws_activity_cursors WHERE session_id=?',session.id);
    const batch = await withExistingMailboxSession(session.agentId, session.nativeSessionId, (box) => ({
      incoming: box.getWorkspaceInbound?.(cursor.in ?? -1, 200) ?? [],
      outgoing: box.getWorkspaceOutbound?.(cursor.out ?? -1, 200) ?? [],
      events: box.getWorkspaceEvents?.(Math.min(cursor.event ?? 0, notificationCursor, activityCursor?.cursor ?? 0), 500) ?? [],
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
    const activityEvents = batch.events.filter(event=>event.seq > (activityCursor?.cursor ?? 0));
    if (activityEvents.length) {
      await this.archiveActivity(session.id, activityEvents, activityCursor?.value);
      changed = true;
    }
    if (batch.events.some(event=>event.seq > (cursor.event ?? 0))) {
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
    if (batch.events.some(event => ['turn-finished','turn-result','turn-cancelled','turn-error'].includes(event.kind)))
      await this.activitySummaries(session.id);
    // Only reconcile after the event backlog is drained. Recheck runtime truth
    // inside the transaction so a newly launched incarnation is never closed.
    if (batch.events.length < 500) await this.store.db.transaction(async () => {
      const runtime = await this.store.db.get<{container_status:string}>('SELECT container_status FROM sessions WHERE id=?', session.nativeSessionId!);
      if (!runtime || runtime.container_status !== 'stopped') return;
      const live = await this.live(session.id);
      if (!live?.running) return;
      live.running = false;
      if (live.runtimeIncarnation !== undefined && ended?.incarnation !== undefined && live.runtimeIncarnation !== ended.incarnation) return;
      live.error = ended ? `The agent runtime stopped (${ended.reason}) before this turn finished.` : 'The agent runtime stopped before this turn finished.';
      live.updatedAt = stamp();
      for (const tool of Object.values(live.tools ?? {}) as any[]) if (tool.status === 'running') tool.status = 'interrupted';
      await this.store.db.run('UPDATE ws_live SET value=? WHERE session_id=?', JSON.stringify(live), session.id);
      const partialText = (Object.values(live.texts ?? {}) as string[]).map(text => /<message(?:\s[^>]*)?>([\s\S]*)/.exec(text)?.[1]?.replace(/<\/message>[\s\S]*$/, '') ?? '').filter(Boolean).join('\n');
      if (live.startedAt && (Object.keys(live.tools ?? {}).length || live.timeline?.length || partialText)) {
        await this.store.db.run(`INSERT INTO ws_messages (id,session_id,role,kind,text,timestamp,source,files,data)
          VALUES (?,?,'tool','activity','',?,'agent','[]',?) ON CONFLICT(id) DO NOTHING`,
          `${session.id}:${liveActivityKey(live)}`,session.id,live.updatedAt,JSON.stringify({activityKey:liveActivityKey(live),timeline:live.timeline,phase:'interrupted',partialText,startedAt:live.startedAt,endedAt:live.updatedAt,tools:Object.values(live.tools),turnError:live.error}));
      }
      changed = true;
    });
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

  private reduceActivity(live: any, row: WorkspaceMailboxEvent) {
    const data = safeJson(row.content);
    if (row.kind === 'text-delta' || row.kind === 'tool') reduceTimeline(live.timeline ??= [], row.kind, data);
    if(row.kind==='turn-waiting'){live.waiting=true;live.running=false;}
    else if (row.kind === 'turn-start') live = { running: true, startedAt: row.timestamp, tools: {}, texts: {}, timeline: [], usage:live.usage };
    else if(row.kind==='usage') {if(data.reset===true)delete live.usage;else{const usage=parseContextUsage(data);if(usage)live.usage={...usage,updatedAt:row.timestamp};}}
    else if (row.kind === 'text-delta') live.texts[data.id] = typeof data.text === 'string' ? data.text : `${live.texts[data.id] ?? ''}${data.delta ?? ''}`;
    else if (row.kind === 'tool') live.tools[data.id] = { ...live.tools[data.id], ...data };
    else if (row.kind === 'turn-error') { live.error = data.message; live.running = false; }
    else if (row.kind === 'turn-result' || row.kind === 'turn-cancelled') { live.running = false; live.texts = {}; }
    if (['turn-result','turn-error','turn-cancelled','turn-waiting'].includes(row.kind))
      for (const entry of live.timeline ?? []) { if (entry.kind === 'tool' && entry.status === 'running') entry.status = 'interrupted'; }
    live.updatedAt = row.timestamp;
    return live;
  }

  private async archiveActivity(id: string, rows: WorkspaceMailboxEvent[], previous?: string) {
    let state = previous ? JSON.parse(previous) : { running: false, tools: {}, texts: {} };
    const { automaticSummaries } = await this.store.settings();
    for (const row of rows) {
      state = this.reduceActivity(state,row);
      if (state.startedAt && !state.running && (Object.keys(state.tools ?? {}).length || state.timeline?.length)) {
        const key = liveActivityKey(state);
        // A stable message ID makes replay and repeated terminal events idempotent.
        // Keep this display record out of session recency/title and agent mailbox writes.
        const activity = {id:`${id}:${key}`,role:'tool',text:'',files:[],timestamp:row.timestamp,
          data:{activityKey:key,startedAt:state.startedAt,endedAt:row.timestamp,
            timeline:state.timeline,phase:state.waiting?'before-approval':undefined,
            tools:Object.values(state.tools).map((tool:any)=>state.waiting&&tool.status==='running'?{...tool,status:'interrupted'}:tool),turnError:state.error}};
        await this.store.db.run(`INSERT INTO ws_messages (id,session_id,role,kind,text,timestamp,source,files,data)
          VALUES (?,?,'tool','activity','',?,'agent','[]',?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`,
          activity.id,id,row.timestamp,JSON.stringify(activity.data));
        // Queue each archived turn before a following turn-start can replace live state.
        // Timeline blocks own their summaries; the envelope is only for older tool-only turns.
        if (automaticSummaries) {
          const sources = activitySources([activity], null);
          const blocks = sources.filter(source=>source.turnKey);
          for (const source of blocks.length ? blocks : sources)
            await this.queueActivitySummary(id, source, false);
        }
      }
    }
    await this.store.db.run(`INSERT INTO ws_activity_cursors (session_id,cursor,value) VALUES (?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET cursor=excluded.cursor,value=excluded.value`,id,rows.at(-1)!.seq,JSON.stringify(state));
  }

  private async applyEvents(id: string, rows: WorkspaceMailboxEvent[]) {
    let live = (await this.live(id)) ?? { running: false, tools: {}, texts: {} };
    for (const row of rows) {
      live = this.reduceActivity(live,row);

    }
    await this.store.db.run(
      'INSERT INTO ws_live (session_id,value) VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET value=excluded.value',
      id, JSON.stringify(live),
    );
  }

  async activitySummaries(sessionId: string, messages?: ActivityMessage[], live?: any) {
    const session = await this.store.getSession(sessionId);
    const history = messages ?? (await this.store.history(sessionId, undefined, 300)).messages;
    const state = live === undefined ? await this.live(sessionId) : live;
    const sources = activitySources(history, state);
    const settings = await this.store.settings();
    // Backfill only the latest visible block. Older blocks are summarized on demand.
    if (settings.automaticSummaries && sources.length && !state?.running) {
      const latest = sources.at(-1)!;
      for (const source of latest.turnKey ? sources.filter(source=>source.turnKey===latest.turnKey) : [latest])
        await this.queueActivitySummary(sessionId, source, false);
    }
    const rows = await this.store.db.all<any>(
      `SELECT a.group_key,a.summary,a.source_key,a.evidence,j.state,j.error FROM ws_activity_summaries a
       LEFT JOIN ws_utility_jobs j ON j.scope_id=a.id AND j.task='activity-summary' WHERE a.session_id=?`, session.id);
    return Object.fromEntries(rows.filter(row => !row.group_key.startsWith('live:') || sources.some(source => source.key === row.group_key && digest(row.evidence) === row.source_key && sameActivityEvidence(source.key,row.evidence,source.evidence)))
      .map(row => [row.group_key, { text: row.summary, count: sources.find(source=>source.key===row.group_key)?.count ?? row.evidence.split('\n').length, state: row.state, error: row.state === 'failed' ? 'Activity summary unavailable. Check the utility model or retry.' : null }]));
  }

  private async queueActivitySummary(sessionId: string, source: {key: string; evidence: string}, retry: boolean) {
    const id = digest(`${sessionId}:${source.key}`);
    const sourceKey = digest(source.evidence);
    const known = await this.store.db.get<any>("SELECT a.source_key,a.evidence,j.state FROM ws_activity_summaries a LEFT JOIN ws_utility_jobs j ON j.scope_id=a.id AND j.task='activity-summary' WHERE a.id=?",id);
    if (known && (known.source_key === sourceKey || (digest(known.evidence) === known.source_key && sameActivityEvidence(source.key,known.evidence,source.evidence))) && known.state && (!retry || known.state !== 'failed')) return;
    await this.store.db.run(`INSERT INTO ws_activity_summaries (id,session_id,group_key,source_key,evidence,summary,updated_at)
      VALUES (?,?,?,?,?,'',?) ON CONFLICT(id) DO UPDATE SET source_key=excluded.source_key,evidence=excluded.evidence,summary='',updated_at=excluded.updated_at
      WHERE ws_activity_summaries.source_key<>excluded.source_key`, id,sessionId,source.key,sourceKey,source.evidence,stamp());
    if (retry) await this.store.db.run("UPDATE ws_utility_jobs SET state='pending',attempts=0,error=NULL,due_at=? WHERE id=? AND state='failed'",stamp(),`activity-summary:${id}`);
    await this.enqueue(id, 'activity-summary', sourceKey, retry ? 0 : 1000);
  }

  async summarizeActivity(sessionId: string, key: string, messageIds?: unknown) {
    await this.store.getSession(sessionId);
    let messages: ActivityMessage[] = [];
    if (key.startsWith('live:')) {
      const row = await this.store.db.get<any>('SELECT * FROM ws_messages WHERE session_id=? AND id=?',sessionId,`${sessionId}:${key.split(':tools:')[0]}`);
      if (row) messages = [{...row,files:JSON.parse(row.files),data:safeJson(row.data)}];
    } else {
      if (!Array.isArray(messageIds) || !messageIds.length || messageIds.length > 500 ||
          messageIds.some(id => typeof id !== 'string' || id.length > 1000) || new Set(messageIds).size !== messageIds.length)
        throw new WorkspaceError(400, 'Choose an activity block with at most 500 messages.');
      const rows = await this.store.db.all<any>(`SELECT * FROM ws_messages WHERE session_id=? AND id IN (${messageIds.map(()=>'?').join(',')}) ORDER BY timestamp,id`,sessionId,...messageIds);
      messages = rows.map(row => ({...row, files: JSON.parse(row.files), data: safeJson(row.data)}));
      if (messages.length !== messageIds.length || !messages.every(isToolOnly))
        throw new WorkspaceError(400, 'The selected messages are not this conversation’s tool activity.');
    }
    const source = activitySources(messages, await this.live(sessionId)).find(s => s.key === key);
    if (!source) throw new WorkspaceError(409, 'This activity block changed or is no longer available. Refresh the conversation.');
    await this.queueActivitySummary(sessionId, source, true);
    return {ok: true};
  }

  private async workActivitySummary(job: any) {
    const row = await this.store.db.get<any>('SELECT * FROM ws_activity_summaries WHERE id=?',job.scope_id);
    if (!row || row.source_key !== job.source_key) return;
    const session = await this.store.getSession(row.session_id);
    const settings = await this.store.settings();
    const result = await this.models.run(settings.overrides['activity-summary'] ?? settings.utility, {
      task: 'activity-summary', text: row.evidence, current: '', agentId: session.agentId, signal: this.controller.signal,
    });
    await this.store.db.run('UPDATE ws_activity_summaries SET summary=?,updated_at=? WHERE id=? AND source_key=?',result,stamp(),row.id,job.source_key);
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
        if (job.task === 'activity-summary') {
          await this.workActivitySummary(job);
          await this.store.db.run("UPDATE ws_utility_jobs SET state='completed',error=NULL,updated_at=? WHERE id=? AND source_key=?",stamp(),job.id,job.source_key);
          this.changed();
          return;
        }
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
