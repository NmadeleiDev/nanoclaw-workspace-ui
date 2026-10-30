import { execFile, fork, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { WorkspaceStore } from './store.js';
import { WorkspaceError } from './types.js';
import { log } from '../../log.js';

const exec = promisify(execFile);
export const TAILNET_PORT = 8443;
type ServeConfig = {
  TCP?: Record<string, { HTTPS?: boolean }>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
  AllowFunnel?: Record<string, boolean>;
  Foreground?: Record<string, ServeConfig>;
};
export type TailnetStatus = {
  enabled: boolean;
  available: boolean;
  running: boolean;
  url: string | null;
  error: string | null;
  preview: boolean;
};
export interface TailnetRuntime {
  json(args: string[]): Promise<any>;
  start(args: string[]): ChildProcess;
}
const runtime: TailnetRuntime = {
  async json(args) {
    try {
      const { stdout } = await exec('tailscale', args, { timeout: 8000, maxBuffer: 4_000_000 });
      return JSON.parse(stdout);
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
      log.warn('Workspace Tailscale CLI check failed', {
        check: args.join(' '), code: failure.code ?? null,
        killed: failure.killed ?? false, signal: failure.signal ?? null,
      });
      throw new Error('Could not check Tailscale status. Retrying automatically.');
    }
  },
  start(args) {
    const helper = new URL(`./tailnet-process.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`, import.meta.url);
    return fork(fileURLToPath(helper), args, { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  },
};
const configs = (config: ServeConfig): ServeConfig[] => [
  config,
  ...Object.values(config.Foreground ?? {}).flatMap(configs),
];

/** Owns one foreground Serve session; never resets or rewrites another service's configuration. */
export class WorkspaceTailnet {
  private child?: ChildProcess;
  private origin: string | null = null;
  private desired = false;
  private error: string | null = null;
  private timer?: ReturnType<typeof setInterval>;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(
    private store: WorkspaceStore,
    private localPort: number,
    private authorize: (origin: string | null, paused?: boolean) => void,
    private changed: () => void,
    private preview = false,
    private cli = runtime,
  ) {}

  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const next = this.chain.catch(() => {}).then(run);
    this.chain = next;
    return next;
  }
  private async inspect() {
    const state = await this.cli.json(['status', '--json']);
    const name = String(state.Self?.DNSName ?? '')
      .replace(/\.$/, '')
      .toLowerCase();
    // Self.Online describes control-plane connectivity, not whether private Serve traffic works.
    // Keep verifying the running backend and the exact private route even during a control outage.
    if (state.BackendState !== 'Running')
      throw new Error('Connect this Mac to Tailscale first.');
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.ts\.net$/.test(name))
      throw new Error('Tailscale did not report a valid HTTPS device name.');
    const config = (await this.cli.json(['serve', 'status', '--json'])) as ServeConfig;
    return { name, config, url: `https://${name}:${TAILNET_PORT}` };
  }
  private ownsRoute(config: ServeConfig, name: string): boolean {
    const all = configs(config);
    if (all.some((c) => c.AllowFunnel?.[`${name}:${TAILNET_PORT}`])) return false;
    const routes = all.filter((c) => c.TCP?.[String(TAILNET_PORT)]);
    return (
      routes.length === 1 &&
      routes[0].TCP?.[String(TAILNET_PORT)]?.HTTPS === true &&
      routes[0].Web?.[`${name}:${TAILNET_PORT}`]?.Handlers?.['/']?.Proxy === `http://127.0.0.1:${this.localPort}`
    );
  }
  private async release(): Promise<void> {
    this.authorize(null);
    this.origin = null;
    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.child = child;
        reject(new Error('The workspace Tailscale process did not stop.'));
      }, 8000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill('SIGINT');
    });
  }
  async start(): Promise<void> {
    const row = await this.store.db.get<{ value: string }>(
      'SELECT value FROM ws_settings WHERE id=?',
      'tailnet-enabled',
    );
    this.desired = row?.value === 'true';
    if (this.desired && !this.preview)
      await this.serialize(async () => {
        try {
          await this.connect(true);
        } catch (error) {
          this.error = String(error instanceof Error ? error.message : error);
          this.changed();
        }
      });
    this.watch();
  }
  private async connect(waitForPreviousHost = false): Promise<void> {
    if (this.child && this.origin && !this.error) return;
    if (this.child) await this.release();
    let before = await this.inspect();
    if (waitForPreviousHost && this.ownsRoute(before.config, before.name)) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && this.ownsRoute(before.config, before.name)) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        before = await this.inspect();
      }
    }
    if (
      configs(before.config).some(
        (c) => c.TCP?.[String(TAILNET_PORT)] || c.AllowFunnel?.[`${before.name}:${TAILNET_PORT}`],
      )
    )
      throw new Error(`Tailscale port ${TAILNET_PORT} is already in use. Its existing service was left unchanged.`);
    let diagnostic = '';
    let failure: Error | undefined;
    const child = this.cli.start(['serve', `--https=${TAILNET_PORT}`, '--yes', `http://127.0.0.1:${this.localPort}`]);
    this.child = child;
    const output = (chunk: Buffer) => {
      diagnostic = (diagnostic + chunk.toString()).slice(-4000);
    };
    child.stdout?.on('data', output);
    child.stderr?.on('data', output);
    child.on('error', (error) => {
      failure = error;
    });
    child.once('exit', (code, signal) => {
      if (this.child !== child) return;
      log.warn('Workspace Tailscale Serve exited; reconnecting', { code, signal });
      this.child = undefined;
      this.authorize(null);
      this.origin = null;
      this.error = 'Tailscale access stopped. Reconnecting…';
      this.changed();
    });
    try {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (failure) throw failure;
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error(diagnostic.trim() || 'Tailscale Serve exited before it was ready.');
        const current = await this.inspect();
        if (current.name !== before.name)
          throw new Error('The Tailscale device name changed while enabling access. Try again.');
        if (this.ownsRoute(current.config, current.name)) {
          this.origin = current.url;
          this.authorize(this.origin);
          this.error = null;
          log.info('Workspace Tailscale route connected');
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      throw new Error(
        `Tailscale Serve was not ready. ${diagnostic.trim() || 'Check HTTPS and Serve permissions in your tailnet.'}`,
      );
    } catch (error) {
      await this.release();
      throw error;
    }
  }
  private watch(): void {
    if (this.timer || !this.desired || this.preview) return;
    this.timer = setInterval(() => {
      void this.serialize(async () => {
        if (!this.desired) return;
        try {
          if (!this.child) await this.connect(true);
          else {
            const live = await this.inspect();
            if ((this.origin && live.url !== this.origin) || !this.ownsRoute(live.config, live.name)) {
              await this.release();
              throw new Error('The Tailscale route changed or became public.');
            }
            if (this.error) log.info('Workspace Tailscale health check recovered');
            this.origin = live.url;
            this.authorize(this.origin);
            this.error = null;
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          if (this.error !== reason) log.warn('Workspace Tailscale access paused', { reason });
          this.error = reason;
          // Fail closed without destroying a potentially healthy Serve lease.
          // A later verified check restores access; confirmed unsafe routes above are released.
          this.authorize(null, true);
        }
        this.changed();
      }).catch((error) => {
        this.error = String(error);
        this.changed();
      });
    }, 15_000);
  }
  async setEnabled(enabled: unknown): Promise<TailnetStatus> {
    if (typeof enabled !== 'boolean') throw new WorkspaceError(400, 'Choose whether Tailscale access is enabled.');
    if (this.preview) throw new WorkspaceError(403, 'Tailnet access is unavailable in the isolated preview.');
    return this.serialize(async () => {
      try {
        if (enabled) await this.connect();
        await this.store.db.run(
          'INSERT INTO ws_settings (id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',
          'tailnet-enabled',
          JSON.stringify(enabled),
        );
        this.desired = enabled;
        if (!enabled) {
          if (this.timer) clearInterval(this.timer);
          this.timer = undefined;
          await this.release();
        } else this.watch();
        this.error = null;
        this.changed();
        return this.status();
      } catch (error) {
        if (enabled && !this.desired) await this.release();
        this.error = error instanceof Error ? error.message : String(error);
        this.changed();
        throw new WorkspaceError(503, this.error);
      }
    });
  }
  async status(): Promise<TailnetStatus> {
    let available = false;
    let error = this.error;
    try {
      await this.inspect();
      available = true;
    } catch (failure) {
      error ??= failure instanceof Error ? failure.message : String(failure);
    }
    return { enabled: this.desired, available, running: !!this.origin && !this.error, url: this.origin, error, preview: this.preview };
  }
  url(): string {
    if (!this.origin || this.error) throw new WorkspaceError(409, 'Verify Tailscale access before pairing a device.');
    return this.origin;
  }
  async stop() {
    this.desired = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.serialize(() => this.release());
  }
}
