import React, { useEffect, useRef, useState } from 'react';
import { formatLocalTime } from '../../../src/timezone.js';
let notificationTimezone = 'UTC';
export function configureNotificationTimezone(zone: string) {
  notificationTimezone = zone;
}
const localTime = (value: string) => formatLocalTime(value, notificationTimezone);

type Request = <T = any>(url: string, method?: string, data?: unknown, signal?: AbortSignal) => Promise<T>;
let request: Request;
export function configureNotifications(api: Request) {
  request = api;
}
export type Scope = 'agent' | 'project' | 'session';
export type Target = { scope: Scope; id: string; name: string };
type Pref = { mode: 'inherit' | 'on' | 'muted'; snoozedUntil: string | null };
type Global = Pref & { kinds: Record<string, boolean>; preview: string; reading: string };
type Device = {
  has_subscription: number;
  id: string;
  name: string;
  origin: string;
  revoked_at: string | null;
  push_enabled: number;
  last_seen: string;
  last_push_at: string | null;
  last_push_status: string | null;
  push_error: string | null;
};
export type NotificationData = {
  global: Global;
  preferences: (Pref & { scope: string; id: string })[];
  effective: Record<string, { enabled: boolean; source: string }>;
  deviceId: string;
  publicKey: string;
  tailnet: string | null;
  devices: Device[];
};
export type Activity = {
  message_id: string | null;
  id: string;
  session_id: string;
  kind: string;
  text: string;
  title: string;
  agent_name: string;
  project_name: string | null;
  unread: number;
  created_at: string;
  request_id: string | null;
};
export const Bell = ({ muted = false }: { muted?: boolean }) => (
  <svg
    width="19"
    height="19"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
    {muted && <path d="M3 3l18 18" />}
  </svg>
);
export function useNotifications(enabled = true) {
  const [settings, setSettings] = useState<NotificationData | null>(null);
  const [feed, setFeed] = useState<{ items: Activity[]; badge: number; unreadBySession: Record<string, number> }>({ items: [], badge: 0, unreadBySession: {} });
  const [error, setError] = useState('');
  const loading = useRef(false);
  const refresh = async () => {
    if (loading.current) return;
    loading.current = true;
    try {
      const [next, activity] = await Promise.all([
        request<NotificationData>('/notifications'),
        request<{ items: Activity[]; badge: number; unreadBySession: Record<string, number> }>('/notifications/activity'),
      ]);
      setSettings(next);
      setFeed(activity);
      setError('');
      const nav = navigator as Navigator & {
        setAppBadge?: (n: number) => Promise<void>;
        clearAppBadge?: () => Promise<void>;
      };
      if (activity.badge) await nav.setAppBadge?.(activity.badge).catch(() => {});
      else await nav.clearAppBadge?.().catch(() => {});
    } catch (e) {
      setError(String(e).replace(/^Error: /, ''));
    } finally {
      loading.current = false;
    }
  };
  useEffect(() => {
    if (!enabled) return;
    let delay: ReturnType<typeof setTimeout>;
    const change = () => {
      clearTimeout(delay);
      delay = setTimeout(() => void refresh(), 250);
    };
    void refresh();
    window.addEventListener('workspace-change', change);
    const timer = setInterval(() => void refresh(), 15000);
    return () => {
      clearTimeout(delay);
      clearInterval(timer);
      window.removeEventListener('workspace-change', change);
    };
  }, [enabled]);
  return { settings, feed, error, refresh };
}
async function mutate(path: string, data: unknown, method = 'POST') {
  const result = await request(path, method, data);
  window.dispatchEvent(new Event('workspace-change'));
  return result;
}
export async function identifyInstallation() {
  let installationId = localStorage.getItem('ws.installation');
  if (!installationId) {
    installationId = crypto.randomUUID();
    localStorage.setItem('ws.installation', installationId);
  }
  const standalone = matchMedia('(display-mode: standalone)').matches;
  const platform = /iPhone|iPad/.test(navigator.userAgent)
    ? 'iPhone / iPad'
    : /Mac/.test(navigator.userAgent)
      ? 'Mac'
      : 'Browser';
  return request<{ csrf: string }>('/devices/current', 'POST', {
    installationId,
    name: `${platform}${standalone ? ' app' : ''}`,
  });
}
const tabId = crypto.randomUUID();
export function useReadingPresence(enabled: boolean, sessionId: string | null, atLatest: () => boolean) {
  const latest = useRef(atLatest);
  latest.current = atLatest;
  useEffect(() => {
    if (!enabled || !sessionId) return;
    let disposed = false;
    const conversationVisible = () => {
      const element = document.querySelector('.conversation');
      if (!element) return false;
      const box = element.getBoundingClientRect();
      const top = document.elementFromPoint(
        Math.max(0, Math.min(innerWidth - 1, box.x + box.width / 2)),
        Math.max(0, Math.min(innerHeight - 1, box.y + box.height / 2)),
      );
      return box.width > 0 && box.height > 0 && !!top && element.contains(top);
    };
    const update = () =>
      void request('/notifications/presence', 'POST', {
        clientId: tabId,
        sessionId,
        active:
          !disposed &&
          document.visibilityState === 'visible' &&
          document.hasFocus() &&
          conversationVisible() &&
          latest.current(),
      }).catch(() => {});
    update();
    const timer = setInterval(update, 10000);
    window.addEventListener('focus', update);
    window.addEventListener('resize', update);
    window.addEventListener('blur', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      disposed = true;
      update();
      clearInterval(timer);
      window.removeEventListener('focus', update);
      window.removeEventListener('resize', update);
      window.removeEventListener('blur', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, [enabled, sessionId]);
}
function Pause({
  value,
  save,
  resumeMode = 'inherit',
}: {
  value: Pref;
  save: (value: Partial<Pref>) => void;
  resumeMode?: Pref['mode'];
}) {
  return (
    <select
      aria-label="Pause notifications"
      value=""
      onChange={(e) => {
        const hours = Number(e.target.value);
        if (hours)
          save({
            snoozedUntil: new Date(Date.now() + hours * 3600_000).toISOString(),
            ...(value.mode === 'muted' ? { mode: resumeMode } : {}),
          });
      }}
    >
      <option value="" disabled>
        Mute for…
      </option>
      <option value="0.25">
        15 minutes{value.mode === 'muted' ? (resumeMode === 'on' ? ', then on' : ', then follow parent') : ''}
      </option>
      <option value="1">
        1 hour{value.mode === 'muted' ? (resumeMode === 'on' ? ', then on' : ', then follow parent') : ''}
      </option>
      <option value="8">
        8 hours{value.mode === 'muted' ? (resumeMode === 'on' ? ', then on' : ', then follow parent') : ''}
      </option>
      {value.snoozedUntil && Date.parse(value.snoozedUntil) > Date.now() && <option value="0">Paused</option>}
    </select>
  );
}
export function ScopeNotifications({
  target,
  settings,
  saveError,
}: {
  target: Target;
  settings: NotificationData | null;
  saveError?: (s: string) => void;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pref = settings?.preferences.find((p) => p.scope === target.scope && p.id === target.id) ?? {
    mode: 'inherit',
    snoozedUntil: null,
  };
  const effective = target.scope === 'session' ? settings?.effective[target.id] : null;
  const paused = !!pref.snoozedUntil && Date.parse(pref.snoozedUntil) > Date.now();
  const save = async (value: Partial<Pref>) => {
    setBusy(true);
    try {
      await mutate('/notifications/preferences', { scope: target.scope, id: target.id, preference: value }, 'PATCH');
      setError('');
    } catch (e) {
      setError(String(e));
      saveError?.(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="notification-scope" aria-label={`${target.name} notifications`}>
      <div className="notification-scope-heading">
        <Bell muted={effective ? !effective.enabled : paused || pref.mode === 'muted'} />
        <strong>Notifications</strong>
      </div>
      <div className="notification-segments" role="group" aria-label="Notification preference">
        {[
          ['inherit', 'Follow parent'],
          ['on', 'On'],
          ['muted', 'Muted'],
        ].map(([value, label]) => (
          <button
            key={value}
            type="button"
            disabled={busy}
            aria-pressed={pref.mode === value}
            className={pref.mode === value ? 'selected' : ''}
            onClick={() => void save({ mode: value as Pref['mode'], snoozedUntil: null })}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="notification-inline">
        <span className="muted">
          {paused
            ? `Muted until ${localTime(pref.snoozedUntil!)}`
            : effective
              ? `${effective.enabled ? 'On' : 'Muted'} · ${effective.source === 'default' ? 'default' : `by ${effective.source}`}`
              : pref.mode === 'inherit'
                ? `Following ${target.scope === 'project' ? 'each session’s agent' : target.scope === 'agent' ? 'workspace' : 'project, then agent'}`
                : pref.mode === 'on'
                  ? 'Explicitly on'
                  : 'Muted'}
          {settings?.global.mode !== 'on' ? ' · global notifications off' : ''}
        </span>
        <Pause value={pref} save={(v) => void save(v)} />
        {paused && (
          <button className="text-button" type="button" onClick={() => void save({ snoozedUntil: null })}>
            Resume
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
    </section>
  );
}
function DeviceCard({
  device,
  current,
  run,
}: {
  device: Device;
  current: boolean;
  run: (fn: () => Promise<unknown>) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(device.name);
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="notification-device" role="group" aria-label={device.name}>
      <div>
        <strong>
          {device.name}
          {current && <span className="notification-chip">This device</span>}
        </strong>
        <small>
          {device.revoked_at ? 'Disconnected' : device.push_enabled ? 'Push enabled' : 'Push off'} · Last seen{' '}
          {localTime(device.last_seen)}
        </small>
        {device.last_push_status && (
          <small>
            Last push: {device.last_push_status === 'accepted' ? 'accepted by push service' : device.last_push_status}
            {device.last_push_at ? ` · ${localTime(device.last_push_at)}` : ''}
          </small>
        )}
        {device.push_error && (
          <p className="error-message" role="status">
            {device.push_error}
          </p>
        )}
      </div>
      {!device.revoked_at && (
        <div className="notification-device-actions">
          {device.push_enabled !== 0 && (
            <button
              className="button secondary small"
              onClick={() => run(() => mutate('/notifications/test', { deviceId: device.id }))}
            >
              Send test
            </button>
          )}
          <button
            className="button secondary small"
            disabled={!device.push_enabled && !device.has_subscription}
            onClick={() => run(() => mutate(`/devices/${device.id}`, { pushEnabled: !device.push_enabled }, 'PATCH'))}
          >
            {device.push_enabled ? 'Disable push' : device.has_subscription ? 'Enable push' : 'Enable on that device'}
          </button>
          <button className="text-button" onClick={() => setRenaming(!renaming)}>
            Rename
          </button>
          <button className="text-button" onClick={() => setConfirm(!confirm)}>
            Disconnect
          </button>
        </div>
      )}
      {!!device.revoked_at && (
        <div className="notification-device-actions">
          <button type="button" className="text-button" onClick={() => setConfirm(!confirm)}>
            Remove
          </button>
        </div>
      )}
      {renaming && !device.revoked_at && (
        <form
          className="notification-inline"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => mutate(`/devices/${device.id}`, { name }, 'PATCH'));
            setRenaming(false);
          }}
        >
          <input aria-label="Device name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
          <button className="button secondary small">Save name</button>
        </form>
      )}
      {confirm && (
        <div className="notification-confirm">
          <span>{device.revoked_at ? `Remove ${device.name} from the device list? It is already disconnected.` : `Disconnect ${current ? 'this device' : device.name}? A new pairing will be needed.`}</span>
          <button
            className="button secondary small"
            onClick={() => {
              run(() => device.revoked_at
                ? mutate(`/devices/${device.id}`, undefined, 'DELETE')
                : mutate(`/devices/${device.id}`, { revoked: true }, 'PATCH'));
              setConfirm(false);
            }}
          >
            {device.revoked_at ? 'Remove device' : 'Disconnect device'}
          </button>
          <button type="button" className="text-button" onClick={() => setConfirm(false)}>Cancel</button>
        </div>
      )}
    </div>
  );
}
export function InstallApp() {
  const installed = matchMedia('(display-mode: standalone)').matches;
  return (
    <details className="notification-install">
      <summary>{installed ? 'Home Screen app installed' : 'Install the iPhone app'}</summary>
      <ol>
        <li>Connect your iPhone to Tailscale and open this workspace’s HTTPS address in Safari.</li>
        <li>Tap Share → Add to Home Screen. Keep “Open as Web App” enabled if shown.</li>
        <li>Open NanoClaw from the Home Screen. If asked, enter a pairing code from Settings → Access on your workspace host.</li>
        <li>Open Notifications and tap Enable notifications on this device.</li>
      </ol>
      <p className="muted">
        The workspace host must be awake and NanoClaw running to send new notifications. Tailscale is needed to open conversations.
        iPhone Focus controls quiet time.
      </p>
    </details>
  );
}
export function NotificationSettings({
  data,
}: {
  data?: {
    agents: { id: string; name: string }[];
    projects: { id: string; name: string }[];
    sessions: { id: string; title: string }[];
  };
}) {
  const { settings, error, refresh } = useNotifications();
  const [actionError, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  const [scope, setScope] = useState<Scope>('agent');
  const [selected, setSelected] = useState('');
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setDone('');
    try {
      await fn();
      setError('');
      await refresh();
      setDone('Saved.');
    } catch (e) {
      setError(String(e).replace(/^Error: /, ''));
    } finally {
      setBusy(false);
    }
  };
  const global = settings?.global;
  if (!settings || !global) return <p role="status">{error || 'Loading notification settings…'}</p>;
  const save = (preference: Partial<Global>) =>
    run(() => mutate('/notifications/preferences', { scope: 'global', preference }, 'PATCH'));
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const iphone = /iPhone|iPad/.test(navigator.userAgent);
  const installed = matchMedia('(display-mode: standalone)').matches;
  const permission = supported ? Notification.permission : 'unsupported';
  const current = settings.devices.find((d) => d.id === settings.deviceId);
  const enable = async () => {
    setBusy(true);
    setError('');
    try {
      // Permission request is synchronous with this explicit user gesture.
      const permissionRequest = Notification.requestPermission();
      if ((await permissionRequest) !== 'granted')
        throw new Error('Permission was not granted. Allow notifications in your device settings, then try again.');
      const registration = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('App installation is not ready. Reload the app and try again.')), 10000),
        ),
      ]);
      const key = Uint8Array.from(atob(settings.publicKey.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
        c.charCodeAt(0),
      );
      let existing = await registration.pushManager.getSubscription();
      if (existing && !current?.has_subscription) {
        await existing.unsubscribe();
        existing = null;
      }
      const subscription =
        existing ?? (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
      await mutate('/notifications/subscribe', { subscription: subscription.toJSON() });
      await refresh();
      setDone('Notifications enabled on this device.');
    } catch (e) {
      setError(String(e).replace(/^Error: /, ''));
    } finally {
      setBusy(false);
    }
  };
  const choices = data
    ? scope === 'agent'
      ? data.agents.map((a) => ({ id: a.id, name: a.name }))
      : scope === 'project'
        ? data.projects.map((p) => ({ id: p.id, name: p.name }))
        : data.sessions.map((s) => ({ id: s.id, name: s.title }))
    : [];
  const target = choices.find((c) => c.id === selected);
  const paused = global.snoozedUntil && Date.parse(global.snoozedUntil) > Date.now();
  return (
    <div className="notification-settings" aria-busy={busy}>
      <div className="settings-section-heading">
        <h3>Notifications</h3>
      </div>
      <div className="setting-line">
        <div>
          <strong>Global notifications</strong>
          <span>
            {global.mode === 'on' ? 'Enabled across your paired devices' : 'All notification delivery is off'}
          </span>
        </div>
        <button
          className="notification-switch"
          role="switch"
          aria-checked={global.mode === 'on'}
          aria-label="Global notifications"
          disabled={busy}
          onClick={() => void save({ mode: global.mode === 'on' ? 'muted' : 'on' })}
        >
          <i />
        </button>
      </div>
      <div className="notification-inline">
        <Pause resumeMode="on" value={global} save={(v) => void save(v)} />
        {paused && (
          <>
            <span>Paused until {localTime(global.snoozedUntil!)}</span>
            <button className="text-button" onClick={() => void save({ snoozedUntil: null })}>
              Resume now
            </button>
          </>
        )}
      </div>
      <fieldset className="notification-fieldset">
        <legend>Notify me about</legend>
        {[
          ['reply', 'Completed replies'],
          ['question', 'Questions for me'],
          ['approval', 'Approval requests'],
          ['failure', 'Session failures'],
        ].map(([kind, label]) => (
          <label className="notification-checkbox" key={kind}>
            <input
              type="checkbox"
              checked={global.kinds[kind]}
              disabled={busy}
              onChange={(e) => void save({ kinds: { ...global.kinds, [kind]: e.target.checked } })}
            />
            {label}
          </label>
        ))}
      </fieldset>
      <label className="notification-field">
        Notification preview
        <select value={global.preview} disabled={busy} onChange={(e) => void save({ preview: e.target.value })}>
          <option value="message">Names and message preview</option>
          <option value="names">Names only</option>
          <option value="private">Private · no names or message text</option>
        </select>
      </label>
      <label className="notification-field">
        While reading this session
        <select value={global.reading} disabled={busy} onChange={(e) => void save({ reading: e.target.value })}>
          <option value="any">Skip replies while reading on any device</option>
          <option value="device">Skip only on the device I’m reading</option>
          <option value="always">Always notify</option>
        </select>
      </label>
      <details className="notification-help">
        <summary>How notification rules work</summary>
        <p>
          Session overrides project; project overrides agent. Global off and device off stop delivery. Questions,
          approvals, and failures still notify other devices while you’re reading. Only conversations started or
          continued here trigger notifications. Muting keeps activity in your inbox.
        </p>
      </details>
      <section className="notification-device-setup">
        <h4>This device</h4>
        <p role="status">
          {!supported
            ? 'Push is not supported in this browser.'
            : iphone && !installed
              ? 'Install the Home Screen app to enable iPhone notifications.'
              : permission === 'denied'
                ? 'Notifications are blocked in device settings.'
                : current?.push_enabled
                  ? 'Notifications enabled'
                  : permission === 'granted'
                    ? 'Permission granted · push is off'
                    : 'Notification permission has not been requested.'}
        </p>
        <button
          className="button primary"
          disabled={
            busy ||
            !supported ||
            (iphone && !installed) ||
            !settings.tailnet ||
            location.origin !== settings.tailnet ||
            permission === 'denied' ||
            !!current?.push_enabled
          }
          onClick={() => void enable()}
        >
          Enable notifications on this device
        </button>
        {(!settings.tailnet || location.origin !== settings.tailnet) && (
          <p className="muted">Use the private HTTPS address in Settings → Access to enable push.</p>
        )}
        <InstallApp />
      </section>
      {data && (
        <section className="notification-overrides">
          <h4>Agent, project and session preferences</h4>
          <div className="notification-inline">
            <select
              aria-label="Notification scope"
              value={scope}
              onChange={(e) => {
                setScope(e.target.value as Scope);
                setSelected('');
              }}
            >
              <option value="agent">Agents</option>
              <option value="project">Projects</option>
              <option value="session">Sessions</option>
            </select>
            <select
              aria-label="Choose notification scope"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
            >
              <option value="">Choose {scope}…</option>
              {choices.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          {target && <ScopeNotifications target={{ ...target, scope }} settings={settings} />}
        </section>
      )}
      <section>
        <h4>Paired devices</h4>
        <div className="notification-devices">
          {settings.devices.map((device) => (
            <DeviceCard
              key={device.id}
              device={device}
              current={device.id === settings.deviceId}
              run={(fn) => void run(fn)}
            />
          ))}
        </div>
      </section>
      {(actionError || error) && (
        <p role="alert" className="error-message">
          {actionError || error}
        </p>
      )}
      {done && (
        <p role="status" className="muted">
          {done}
        </p>
      )}
    </div>
  );
}
export function ActivityInbox({
  feed,
  settings,
  choose,
  openSettings,
}: {
  feed: { items: Activity[]; badge: number; unreadBySession: Record<string, number> };
  settings: NotificationData | null;
  choose: (id: string, activityId: string) => void;
  openSettings: () => void;
}) {
  const [error, setError] = useState('');
  const run = (fn: () => Promise<unknown>) => void fn().catch((e) => setError(String(e)));
  return (
    <div className="activity-inbox" role="region" aria-label="Recent activity" tabIndex={0}>
      <div className="notification-inline">
        <button className="button secondary small" onClick={() => run(() => mutate('/notifications/read', {}))}>
          Mark all read
        </button>
        <button className="button secondary small" onClick={openSettings}>
          Notification settings
        </button>
        {settings && (
          <Pause
            resumeMode="on"
            value={settings.global}
            save={(preference) =>
              run(() => mutate('/notifications/preferences', { scope: 'global', preference }, 'PATCH'))
            }
          />
        )}
      </div>
      {settings &&
        (settings.global.mode !== 'on' ||
          (settings.global.snoozedUntil && Date.parse(settings.global.snoozedUntil) > Date.now())) && (
          <p className="notification-pause-status">
            <Bell muted />
            Notification delivery is {settings.global.mode !== 'on' ? 'off' : 'paused'}
          </p>
        )}
      {!feed.items.length && (
        <div className="activity-empty">
          <Bell />
          <h3>You’re all caught up.</h3>
          <p>Replies and requests from your workspace conversations will appear here.</p>
        </div>
      )}
      {feed.items.map((item) => (
        <button
          className={`activity-item ${item.unread ? 'unread' : ''}`}
          key={item.id}
          onClick={() => {
            run(() => mutate('/notifications/read', { id: item.id }));
            choose(item.session_id, item.id);
          }}
        >
          <span className={`activity-indicator ${item.kind}`} />
          <span>
            <strong>
              {item.agent_name} <span className="muted">· {item.project_name ?? item.title}</span>
            </strong>
            <span className="activity-kind">
              {
                {
                  reply: 'New reply',
                  question: 'Question for you',
                  approval: 'Approval needed',
                  failure: 'Session needs attention',
                }[item.kind]
              }
            </span>
            <span>{item.text}</span>
            <small>{localTime(item.created_at)}</small>
          </span>
        </button>
      ))}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
export function PairingCode({ paired }: { paired: () => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (error) {
      errorRef.current?.focus();
      errorRef.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [error]);
  return (
    <form
      className="notification-pair"
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        setError('');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
          await request('/pair', 'POST', { token: code }, controller.signal);
          await request('/me', 'GET', undefined, controller.signal);
          paired();
        } catch (e) {
          setError(
            controller.signal.aborted
              ? 'Could not reach your workspace host. Check Tailscale and try again.'
              : String(e).replace(/^Error: /, ''),
          );
        } finally {
          clearTimeout(timer);
          setBusy(false);
        }
      }}
    >
      <label>
        Pairing code
        <input
          aria-invalid={!!error}
          aria-describedby={error ? 'pairing-error' : undefined}
          autoComplete="one-time-code"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder="XXXX-XXXX-XXXX"
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
            setError('');
          }}
          maxLength={30}
        />
      </label>
      {error && (
        <p ref={errorRef} id="pairing-error" className="pairing-error" tabIndex={-1} role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="button primary" disabled={busy || !code.trim()}>
        {busy ? 'Pairing…' : 'Pair this device'}
      </button>
      <span className="muted">
        Create a code in Settings → Access on your workspace host. If the workspace host cannot be reached, connect Tailscale and retry.
      </span>
      <InstallApp />
    </form>
  );
}
let registration: Promise<ServiceWorkerRegistration> | undefined;
export function registerWorkspacePwa() {
  if (!('serviceWorker' in navigator)) return;
  registration ??= navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
  void registration
    .then((r) => {
      const ready = () => window.dispatchEvent(new CustomEvent('workspace-update', { detail: r }));
      if (r.waiting) ready();
      r.addEventListener('updatefound', () => {
        r.installing?.addEventListener('statechange', () => {
          if (r.waiting && navigator.serviceWorker.controller) ready();
        });
      });
    })
    .catch(() => {});
}

export function DeviceAccess() {
  const { settings, error, refresh } = useNotifications();
  const [actionError, setError] = useState('');
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await refresh();
      setError('');
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <section className="notification-access-devices">
      <h4>Remembered devices</h4>
      {settings?.devices.map((d) => (
        <DeviceCard key={d.id} device={d} current={d.id === settings.deviceId} run={(fn) => void run(fn)} />
      ))}
      {(error || actionError) && <p role="alert">{actionError || error}</p>}
    </section>
  );
}
