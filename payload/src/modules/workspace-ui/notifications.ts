import { ECDH, randomUUID } from 'node:crypto';
import webpush from 'web-push';
import { isOwner } from '../permissions/db/user-roles.js';
import type { WorkspaceStore } from './store.js';
import { WorkspaceError, requiredText, type WorkspaceSession } from './types.js';

export type NotificationKind = 'reply' | 'question' | 'approval' | 'failure';
export type NotificationScope = 'global' | 'agent' | 'project' | 'session';
export interface NotificationPreference {
  mode: 'inherit' | 'on' | 'muted';
  snoozedUntil: string | null;
}
export interface GlobalNotifications extends NotificationPreference {
  kinds: Record<NotificationKind, boolean>;
  preview: 'message' | 'names' | 'private';
  reading: 'any' | 'device' | 'always';
}
export const DEFAULT_NOTIFICATIONS: GlobalNotifications = {
  mode: 'muted',
  snoozedUntil: null,
  kinds: { reply: true, question: true, approval: true, failure: true },
  preview: 'message',
  reading: 'any',
};
type Device = { id: string; owner_id: string; origin: string; push_enabled: number; subscription: string | null };
type Activity = {
  id: string;
  session_id: string;
  kind: NotificationKind;
  text: string;
  request_id: string | null;
  message_id: string | null;
  created_at: string;
  expires_at: string;
};
type Pending = {
  id: string;
  session_id?: string;
  type: string;
  title?: string;
  question?: string;
  expires_at?: string;
};
export type PushTransport = (
  subscription: webpush.PushSubscription,
  payload: string,
  options: webpush.RequestOptions,
) => Promise<unknown>;
const iso = () => new Date().toISOString();
const activeMute = (p: NotificationPreference) => p.snoozedUntil != null && Date.parse(p.snoozedUntil) > Date.now();
export function plainPreview(text: string): string {
  return Array.from(
    text
      .replace(/<[^>]*>/g, '')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[`*_#>]/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
  )
    .slice(0, 200)
    .join('');
}
export function validateSubscription(value: unknown): webpush.PushSubscription {
  const s = value as webpush.PushSubscription;
  let url: URL;
  try {
    url = new URL(s?.endpoint);
  } catch {
    throw new WorkspaceError(400, 'Invalid push subscription.');
  }
  const allowed =
    url.hostname === 'fcm.googleapis.com' ||
    url.hostname === 'updates.push.services.mozilla.com' ||
    /^[a-z0-9-]+\.push\.apple\.com$/.test(url.hostname) ||
    url.hostname === 'web.push.apple.com';
  if (
    !allowed ||
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    !s.keys ||
    !/^[\w-]{86,90}={0,2}$/.test(s.keys.p256dh) ||
    !/^[\w-]{22,24}={0,2}$/.test(s.keys.auth)
  )
    throw new WorkspaceError(400, 'Unsupported or invalid push subscription endpoint.');
  const publicKey = Buffer.from(s.keys.p256dh, 'base64url');
  if (publicKey.length !== 65 || publicKey[0] !== 4 || Buffer.from(s.keys.auth, 'base64url').length !== 16)
    throw new WorkspaceError(400, 'Invalid push encryption keys.');
  try {
    ECDH.convertKey(publicKey, 'prime256v1');
  } catch {
    throw new WorkspaceError(400, 'Invalid push encryption key.');
  }
  return { endpoint: url.href, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } };
}

export class WorkspaceNotifications {
  private presence = new Map<string, { ownerId: string; deviceId: string; sessionId: string; expires: number }>();
  private baseline = '';
  private busy = false;
  private stopped = false;
  constructor(
    readonly store: WorkspaceStore,
    private origin: () => string | null,
    private changed: () => void,
    private sendPush: PushTransport = webpush.sendNotification,
  ) {}

  async start() {
    this.stopped = false;
    this.baseline =
      (await this.store.db.get<{ value: string }>('SELECT value FROM ws_settings WHERE id=?', 'notification-baseline'))
        ?.value ?? iso();
    if (!(await this.store.db.get('SELECT id FROM ws_settings WHERE id=?', 'web-push-vapid'))) {
      await this.store.db.run(
        'INSERT INTO ws_settings (id,value) VALUES (?,?) ON CONFLICT(id) DO NOTHING',
        'web-push-vapid',
        JSON.stringify(webpush.generateVAPIDKeys()),
      );
    }
  }

  async stop() {
    this.stopped = true;
    while (this.busy) await new Promise((resolve) => setTimeout(resolve, 25));
  }

  async preference(owner: string, scope: NotificationScope, id = ''): Promise<GlobalNotifications> {
    const row = await this.store.db.get<{ value: string }>(
      'SELECT value FROM ws_notification_preferences WHERE owner_id=? AND scope=? AND scope_id=?',
      owner,
      scope,
      id,
    );
    return {
      ...structuredClone(DEFAULT_NOTIFICATIONS),
      mode: scope === 'global' ? 'muted' : 'inherit',
      ...(row ? JSON.parse(row.value) : {}),
    };
  }

  async savePreference(owner: string, scope: NotificationScope, id: string, input: Record<string, unknown>) {
    if (!['global', 'agent', 'project', 'session'].includes(scope))
      throw new WorkspaceError(400, 'Unknown notification scope.');
    if (scope !== 'global') {
      const table = { agent: 'agent_groups', project: 'ws_projects', session: 'ws_sessions' }[scope];
      if (!(await this.store.db.get(`SELECT id FROM ${table} WHERE id=?`, id)))
        throw new WorkspaceError(404, 'Notification scope not found.');
    }
    if (scope === 'global') id = '';
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new WorkspaceError(400, 'Invalid notification preferences.');
    const previous = await this.preference(owner, scope, id);
    const value = Object.fromEntries(
      Object.keys(DEFAULT_NOTIFICATIONS).map((key) => [
        key,
        key in input ? input[key] : previous[key as keyof GlobalNotifications],
      ]),
    ) as unknown as GlobalNotifications;
    if (
      !['inherit', 'on', 'muted'].includes(value.mode) ||
      (scope === 'global' && value.mode === 'inherit') ||
      (value.snoozedUntil != null &&
        (!Number.isFinite(Date.parse(value.snoozedUntil)) ||
          Date.parse(value.snoozedUntil) > Date.now() + 8 * 3600_000 + 60_000)) ||
      !['message', 'names', 'private'].includes(value.preview) ||
      !['any', 'device', 'always'].includes(value.reading) ||
      !value.kinds ||
      ['reply', 'question', 'approval', 'failure'].some(
        (kind) => typeof value.kinds[kind as NotificationKind] !== 'boolean',
      )
    )
      throw new WorkspaceError(400, 'Invalid notification preferences.');
    if (value.snoozedUntil != null) value.snoozedUntil = new Date(value.snoozedUntil).toISOString();
    await this.store.db.run(
      'INSERT INTO ws_notification_preferences (owner_id,scope,scope_id,value) VALUES (?,?,?,?) ON CONFLICT(owner_id,scope,scope_id) DO UPDATE SET value=excluded.value',
      owner,
      scope,
      scope === 'global' ? '' : id,
      JSON.stringify(value),
    );
    this.changed();
    return value;
  }

  async effective(owner: string, session: WorkspaceSession) {
    const global = await this.preference(owner, 'global');
    if (global.mode !== 'on' || activeMute(global)) return { enabled: false, source: 'global', global };
    for (const [scope, id] of [
      ['session', session.id],
      ['project', session.projectId],
      ['agent', session.agentId],
    ] as const) {
      if (!id) continue;
      const pref = await this.preference(owner, scope, id);
      if (activeMute(pref) || pref.mode !== 'inherit')
        return { enabled: !activeMute(pref) && pref.mode === 'on', source: scope, global };
    }
    return { enabled: true, source: 'default', global };
  }

  async settings(owner: string, deviceId: string) {
    const preferences = await this.store.db.all<{ scope: string; scope_id: string; value: string }>(
      'SELECT scope,scope_id,value FROM ws_notification_preferences WHERE owner_id=?',
      owner,
    );
    const sessions = await this.store.sessions();
    const effective: Record<string, { enabled: boolean; source: string }> = {};
    for (const session of sessions) {
      const resolved = await this.effective(owner, session);
      effective[session.id] = { enabled: resolved.enabled, source: resolved.source };
    }
    const keys = await this.store.db.get<{ value: string }>(
      'SELECT value FROM ws_settings WHERE id=?',
      'web-push-vapid',
    );
    return {
      global: await this.preference(owner, 'global'),
      preferences: preferences.map((p) => ({ scope: p.scope, id: p.scope_id, ...JSON.parse(p.value) })),
      effective,
      deviceId,
      publicKey: keys ? JSON.parse(keys.value).publicKey : null,
      tailnet: this.origin(),
      devices: await this.devices(owner),
    };
  }

  async devices(owner: string) {
    return this.store.db.all(
      'SELECT id,name,origin,created_at,last_seen,revoked_at,push_enabled,last_push_at,last_push_status,push_error,CASE WHEN subscription IS NULL THEN 0 ELSE 1 END AS has_subscription FROM ws_devices WHERE owner_id=? ORDER BY created_at DESC',
      owner,
    );
  }
  async updateDevice(owner: string, id: string, input: Record<string, unknown>) {
    const device = await this.store.db.get<Device>(
      'SELECT * FROM ws_devices WHERE id=? AND owner_id=? AND revoked_at IS NULL',
      id,
      owner,
    );
    if (!device) throw new WorkspaceError(404, 'Device not found.');
    if ('name' in input)
      await this.store.db.run(
        'UPDATE ws_devices SET name=? WHERE id=?',
        requiredText(input.name, 'Device name', 80),
        id,
      );
    if ('pushEnabled' in input) {
      if (typeof input.pushEnabled !== 'boolean') throw new WorkspaceError(400, 'Invalid device preference.');
      if (input.pushEnabled && !device.subscription)
        throw new WorkspaceError(409, 'Enable notifications on that device first.');
      await this.store.db.run('UPDATE ws_devices SET push_enabled=? WHERE id=?', input.pushEnabled ? 1 : 0, id);
    }
    if (input.revoked === true) {
      await this.store.db.run(
        'UPDATE ws_devices SET revoked_at=?,push_enabled=0,subscription=NULL WHERE id=?',
        iso(),
        id,
      );
      for (const [key, presence] of this.presence) if (presence.deviceId === id) this.presence.delete(key);
      await this.store.db.run("UPDATE ws_push_outbox SET state='cancelled' WHERE device_id=? AND state='pending'", id);
    }
    this.changed();
  }
  async removeDevice(owner: string, id: string) {
    await this.store.db.transaction(async () => {
      const device = await this.store.db.get<{ revoked_at: string | null }>(
        'SELECT revoked_at FROM ws_devices WHERE id=? AND owner_id=?', id, owner,
      );
      if (!device) throw new WorkspaceError(404, 'Device not found.');
      if (!device.revoked_at) throw new WorkspaceError(409, 'Disconnect this device before removing it.');
      await this.store.db.run('DELETE FROM ws_devices WHERE id=? AND owner_id=? AND revoked_at IS NOT NULL', id, owner);
    });
    for (const [key, presence] of this.presence) if (presence.deviceId === id) this.presence.delete(key);
    this.changed();
  }

  async subscribe(owner: string, id: string, value: unknown) {
    const subscription = validateSubscription(value);
    const device = await this.store.db.get<Device>(
      'SELECT * FROM ws_devices WHERE id=? AND owner_id=? AND revoked_at IS NULL',
      id,
      owner,
    );
    if (!device || device.origin !== this.origin())
      throw new WorkspaceError(409, 'Use the private HTTPS workspace address to enable push.');
    await this.store.db.run(
      'UPDATE ws_devices SET subscription=?,push_enabled=1,push_error=NULL WHERE id=?',
      JSON.stringify(subscription),
      id,
    );
    this.changed();
  }
  async heartbeat(ownerId: string, deviceId: string, input: Record<string, unknown>) {
    const clientId = requiredText(input.clientId, 'Tab id', 100);
    const key = deviceId + ':' + clientId;
    if (!input.active) {
      this.presence.delete(key);
      return;
    }
    const sessionId = requiredText(input.sessionId, 'Session', 200);
    await this.store.getSession(sessionId);
    if (this.presence.size > 500)
      for (const [id, p] of this.presence) if (p.expires < Date.now()) this.presence.delete(id);
    this.presence.set(key, { ownerId, deviceId, sessionId, expires: Date.now() + 30_000 });
    await this.markRead(ownerId, sessionId);
  }
  private reading(
    owner: string,
    device: string,
    session: string,
    mode: GlobalNotifications['reading'],
    kind: NotificationKind,
  ) {
    if (mode === 'always') return false;
    return [...this.presence.values()].some(
      (p) =>
        p.ownerId === owner &&
        p.sessionId === session &&
        p.expires > Date.now() &&
        (p.deviceId === device || (kind === 'reply' && mode === 'any')),
    );
  }
  async markRead(owner: string, session?: string, id?: string) {
    const result = await this.store.db.run(
      `INSERT INTO ws_activity_read (owner_id,activity_id) SELECT ?,id FROM ws_activity WHERE ${session ? 'session_id=?' : id ? 'id=?' : '1=1'} ON CONFLICT(owner_id,activity_id) DO NOTHING`,
      owner,
      ...(session ? [session] : id ? [id] : []),
    );
    if (result.changes) this.changed();
  }
  async activity(owner: string, activityId?: string) {
    const items = await this.store.db.all<
      Activity & { unread: number; title: string; agent_name: string; project_name: string | null }
    >(
      `SELECT a.*,s.title,g.name AS agent_name,p.name AS project_name,CASE WHEN r.activity_id IS NULL THEN 1 ELSE 0 END AS unread
      FROM ws_activity a JOIN ws_sessions s ON s.id=a.session_id JOIN agent_groups g ON g.id=s.agent_id
      LEFT JOIN ws_projects p ON p.id=s.project_id LEFT JOIN ws_activity_read r ON r.activity_id=a.id AND r.owner_id=? ${activityId ? 'WHERE a.id=?' : ''} ORDER BY a.created_at DESC,a.id DESC LIMIT 200`,
      owner,
      ...(activityId ? [activityId] : []),
    );
    let badge = 0;
    const unread = await this.store.db.all<{ session_id: string; kind: NotificationKind; count: number }>(
      `SELECT a.session_id,a.kind,COUNT(*) AS count FROM ws_activity a LEFT JOIN ws_activity_read r ON r.activity_id=a.id AND r.owner_id=? WHERE r.activity_id IS NULL AND a.created_at>=? GROUP BY a.session_id,a.kind`,
      owner,
      new Date(Date.now() - 30 * 86400_000).toISOString(),
    );
    const effective = new Map<string, Awaited<ReturnType<WorkspaceNotifications['effective']>>>();
    for (const row of unread) {
      let preference = effective.get(row.session_id);
      if (!preference) {
        preference = await this.effective(owner, await this.store.getSession(row.session_id));
        effective.set(row.session_id, preference);
      }
      if (preference.enabled && preference.global.kinds[row.kind]) badge += row.count;
    }
    // Message unread state is independent of push preferences and the 200-item activity page.
    const replies = await this.store.db.all<{ session_id: string; count: number }>(
      `SELECT a.session_id,COUNT(*) AS count FROM ws_activity a
       LEFT JOIN ws_activity_read r ON r.activity_id=a.id AND r.owner_id=?
       WHERE r.activity_id IS NULL AND a.kind='reply' GROUP BY a.session_id`, owner,
    );
    const unreadBySession = Object.fromEntries(replies.map(row => [row.session_id, row.count]));
    return { items, badge, unreadBySession };
  }
  async record(
    session: WorkspaceSession,
    kind: NotificationKind,
    text: string,
    source: string,
    at: string,
    requestId: string | null = null,
    expiry?: string,
    messageId?: string,
  ) {
    if (at <= this.baseline || session.origin !== 'native' || !session.nativeSessionId) return;
    const native = await this.store.db.get<{ thread_id: string }>(
      'SELECT thread_id FROM sessions WHERE id=?',
      session.nativeSessionId,
    );
    if (!native?.thread_id?.startsWith('system:workspace:') && !native?.thread_id?.startsWith('system:tasks:')) return;
    const id = randomUUID();
    await this.store.db.transaction(async () => {
      const added = await this.store.db.run(
        'INSERT INTO ws_activity (id,session_id,kind,text,source_id,request_id,message_id,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(source_id) DO NOTHING',
        id,
        session.id,
        kind,
        plainPreview(text),
        source,
        requestId,
        messageId ?? null,
        at,
        expiry ?? new Date(Date.parse(at) + (kind === 'reply' ? 3600_000 : 86400_000)).toISOString(),
      );
      if (!added.changes) return;
      const devices = await this.store.db.all<Device>(
        'SELECT * FROM ws_devices WHERE revoked_at IS NULL AND push_enabled=1',
      );
      for (const device of devices)
        await this.store.db.run(
          "INSERT INTO ws_push_outbox (activity_id,device_id,state,due_at) VALUES (?,?,'pending',?)",
          id,
          device.id,
          iso(),
        );
    });
    this.changed();
  }
  async requests(pending: Pending[]) {
    const current = pending.map((p) => p.id);
    const row = await this.store.db.get<{ value: string }>(
      'SELECT value FROM ws_settings WHERE id=?',
      'notification-requests',
    );
    const previous = row ? (JSON.parse(row.value) as string[]) : current;
    for (const p of pending)
      if (!previous.includes(p.id) && p.session_id) {
        const session = (await this.store.sessions()).find((s) => s.nativeSessionId === p.session_id);
        if (session)
          await this.record(
            session,
            p.type === 'approval' ? 'approval' : 'question',
            p.question || p.title || 'Your input is needed',
            `request:${p.id}`,
            iso(),
            p.id,
            p.expires_at,
          );
      }
    await this.store.db.run(
      'INSERT INTO ws_settings (id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',
      'notification-requests',
      JSON.stringify(current),
    );
  }
  async test(owner: string, id: string) {
    const g = await this.preference(owner, 'global');
    if (g.mode !== 'on' || activeMute(g))
      throw new WorkspaceError(409, 'Turn on global notifications before sending a test.');
    const d = await this.store.db.get<Device>(
      'SELECT * FROM ws_devices WHERE id=? AND owner_id=? AND revoked_at IS NULL AND push_enabled=1',
      id,
      owner,
    );
    if (!d?.subscription || d.origin !== this.origin())
      throw new WorkspaceError(409, 'Enable notifications on this device over Tailscale first.');
    try {
      await this.push(
        d,
        {
          web_push: 8030,
          notification: {
            title: 'NanoClaw',
            body: 'Notifications are working on this device.',
            navigate: d.origin,
            tag: 'nanoclaw-test',
          },
        },
        60,
      );
    } catch (error) {
      await this.failure(d, error);
      throw new WorkspaceError(502, 'Push test failed. Check the device status.');
    }
    this.changed();
  }
  private async push(device: Device, payload: unknown, ttl: number) {
    const keys = JSON.parse(
      (await this.store.db.get<{ value: string }>('SELECT value FROM ws_settings WHERE id=?', 'web-push-vapid'))!.value,
    );
    await this.sendPush(JSON.parse(device.subscription!), JSON.stringify(payload), {
      TTL: ttl,
      urgency: 'normal',
      timeout: 10_000,
      vapidDetails: { subject: device.origin, publicKey: keys.publicKey, privateKey: keys.privateKey },
    });
    await this.store.db.run(
      "UPDATE ws_devices SET last_push_at=?,last_push_status='accepted',push_error=NULL WHERE id=?",
      iso(),
      device.id,
    );
  }
  private async failure(device: Device, error: unknown) {
    const code = Number((error as { statusCode?: number })?.statusCode);
    const message = [404, 410].includes(code)
      ? 'Subscription expired. Enable notifications again on this device.'
      : `Push service unavailable${code ? ` (${code})` : ''}.`;
    await this.store.db.run(
      'UPDATE ws_devices SET push_error=?,last_push_status=?,subscription=CASE WHEN ? THEN NULL ELSE subscription END,push_enabled=CASE WHEN ? THEN 0 ELSE push_enabled END WHERE id=?',
      message,
      'failed',
      [404, 410].includes(code) ? 1 : 0,
      [404, 410].includes(code) ? 1 : 0,
      device.id,
    );
    return code;
  }
  async dispatch(pending: Pending[]) {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      const rows = await this.store.db.all<Activity & { device_id: string; attempts: number }>(
        "SELECT a.*,o.device_id,o.attempts FROM ws_push_outbox o JOIN ws_activity a ON a.id=o.activity_id WHERE o.state='pending' AND o.due_at<=? ORDER BY o.due_at LIMIT 20",
        iso(),
      );
      for (const row of rows) {
        if (this.stopped) break;
        const d = await this.store.db.get<Device>(
          'SELECT * FROM ws_devices WHERE id=? AND revoked_at IS NULL',
          row.device_id,
        );
        const session = await this.store.getSession(row.session_id);
        const unread =
          d &&
          !(await this.store.db.get(
            'SELECT activity_id FROM ws_activity_read WHERE owner_id=? AND activity_id=?',
            d.owner_id,
            row.id,
          ));
        const effective = d && (await this.effective(d.owner_id, session));
        const resolved = row.request_id && !pending.some((p) => p.id === row.request_id);
        const cancelled =
          !d ||
          !d.push_enabled ||
          !d.subscription ||
          !(await isOwner(d.owner_id)) ||
          !this.origin() ||
          d.origin !== this.origin() ||
          Date.parse(row.expires_at) <= Date.now() ||
          !effective?.enabled ||
          !effective.global.kinds[row.kind] ||
          resolved ||
          (row.kind === 'reply' && !unread) ||
          this.reading(d.owner_id, d.id, session.id, effective.global.reading, row.kind);
        if (cancelled) {
          await this.store.db.run(
            "UPDATE ws_push_outbox SET state='cancelled' WHERE activity_id=? AND device_id=?",
            row.id,
            row.device_id,
          );
          continue;
        }
        const agent = await this.store.db.get<{ name: string }>(
          'SELECT name FROM agent_groups WHERE id=?',
          session.agentId,
        );
        const project = session.projectId ? await this.store.getProject(session.projectId) : null;
        const preview = effective!.global.preview;
        const label = {
          reply: 'New reply',
          question: 'Question for you',
          approval: 'Approval needed',
          failure: 'Session needs attention',
        }[row.kind];
        const title =
          preview === 'private'
            ? 'NanoClaw'
            : `${agent?.name ?? 'Agent'} · ${project?.name ?? session.title}`.slice(0, 120);
        const body =
          preview === 'private'
            ? 'NanoClaw needs your attention'
            : preview === 'names'
              ? `${label} · ${session.title}`
              : `${label}: ${row.text || session.title}`;
        const badge = (await this.activity(d.owner_id)).badge;
        try {
          await this.push(
            d,
            {
              web_push: 8030,
              notification: {
                title,
                body,
                navigate: `${d.origin}/?session=${encodeURIComponent(session.id)}&activity=${row.id}`,
                tag: `nc-${row.id}`,
                app_badge: String(badge),
              },
            },
            Math.max(1, Math.ceil((Date.parse(row.expires_at) - Date.now()) / 1000)),
          );
          await this.store.db.run(
            "UPDATE ws_push_outbox SET state='accepted',error=NULL WHERE activity_id=? AND device_id=?",
            row.id,
            d.id,
          );
        } catch (error) {
          const code = await this.failure(d, error);
          const transient = !code || code === 429 || code >= 500;
          const retryAfter = (error as { headers?: Record<string, string> })?.headers?.['retry-after'];
          const retryMs = retryAfter
            ? Number.isFinite(Number(retryAfter))
              ? Number(retryAfter) * 1000
              : Math.max(0, Date.parse(retryAfter) - Date.now())
            : 0;
          const delay = Math.max(Math.min(600_000, 30_000 * 2 ** row.attempts), Number.isFinite(retryMs) ? retryMs : 0);
          await this.store.db.run(
            'UPDATE ws_push_outbox SET state=?,attempts=attempts+1,due_at=?,error=? WHERE activity_id=? AND device_id=?',
            transient && row.attempts < 7 ? 'pending' : 'failed',
            new Date(Date.now() + delay).toISOString(),
            `Push failed${code ? ` (${code})` : ''}`,
            row.id,
            d.id,
          );
        }
      }
      await this.store.db.run(
        'DELETE FROM ws_activity WHERE created_at<?',
        new Date(Date.now() - 30 * 86400_000).toISOString(),
      );
    } finally {
      this.busy = false;
    }
  }
}
