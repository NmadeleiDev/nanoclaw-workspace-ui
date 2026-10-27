import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { beforeEach, afterEach, it, expect, vi, type Mock } from 'vitest';
import { initTestDb, closeDb } from '../../db/connection.js';
import './migration.js';
import { runMigrations } from '../../db/migrations/index.js';
import { WorkspaceStore } from './store.js';
import { WorkspaceTailnet, type TailnetRuntime } from './tailnet.js';

let store: WorkspaceStore;
let network: WorkspaceTailnet;
let route: any;
let child: any;
let enabledOrigin: string | null;
let start: Mock<(args: string[]) => ChildProcess>;
beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(db);
  store = new WorkspaceStore(db);
  route = {
    Foreground: {
      other: {
        TCP: { 443: { HTTPS: true } },
        Web: { 'mac.test.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:63663' } } } },
      },
    },
  };
  enabledOrigin = null;
  start = vi.fn((_args: string[]) => {
    child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      signalCode: null,
    });
    route.Foreground.workspace = {
      TCP: { 8443: { HTTPS: true } },
      Web: { 'mac.test.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3210' } } } },
    };
    child.kill = vi.fn(() => {
      delete route.Foreground.workspace;
      child.exitCode = 0;
      queueMicrotask(() => child.emit('exit', 0, null));
      return true;
    });
    return child as ChildProcess;
  });
  const cli: TailnetRuntime = {
    start,
    async json(args) {
      return args[0] === 'status'
        ? { BackendState: 'Running', Self: { DNSName: 'mac.test.ts.net.', Online: true } }
        : structuredClone(route);
    },
  };
  network = new WorkspaceTailnet(
    store,
    3210,
    (origin) => {
      enabledOrigin = origin;
    },
    () => {},
    false,
    cli,
  );
});
afterEach(async () => {
  await network.stop();
  vi.useRealTimers();
  await closeDb();
});
it('preserves another Serve session while enabling and disabling only its own private HTTPS route', async () => {
  const other = structuredClone(route.Foreground.other);
  expect((await network.setEnabled(true)).url).toBe('https://mac.test.ts.net:8443');
  expect(enabledOrigin).toBe('https://mac.test.ts.net:8443');
  expect(start).toHaveBeenCalledWith(['serve', '--https=8443', '--yes', 'http://127.0.0.1:3210']);
  expect((await store.db.get<any>('SELECT value FROM ws_settings WHERE id=?', 'tailnet-enabled')).value).toBe('true');
  await network.setEnabled(false);
  expect(child.kill).toHaveBeenCalledWith('SIGINT');
  expect(enabledOrigin).toBeNull();
  expect(route.Foreground).toEqual({ other });
});
it('does not replace an occupied port or persist an enable request that failed', async () => {
  route.TCP = { 8443: { HTTPS: true } };
  await expect(network.setEnabled(true)).rejects.toThrow('already in use');
  expect(start).not.toHaveBeenCalled();
  expect(enabledOrigin).toBeNull();
  expect(await store.db.get('SELECT value FROM ws_settings WHERE id=?', 'tailnet-enabled')).toBeUndefined();
});
it('revokes remote access immediately if its own Serve process exits', async () => {
  await network.setEnabled(true);
  child.exitCode = 1;
  child.emit('exit', 1, null);
  expect(enabledOrigin).toBeNull();
  expect((await network.status()).running).toBe(false);
  expect((await network.status()).error).toContain('stopped');
});
it('fails closed if the route is changed to public exposure', async () => {
  vi.useFakeTimers();
  await network.setEnabled(true);
  route.AllowFunnel = { 'mac.test.ts.net:8443': true };
  await vi.advanceTimersByTimeAsync(15000);
  expect(enabledOrigin).toBeNull();
  expect(child.kill).toHaveBeenCalledOnce();
  expect((await network.status()).error).toContain('public');
});
it('restores a persisted enable setting on host startup', async () => {
  await store.db.run('INSERT INTO ws_settings VALUES (?,?)', 'tailnet-enabled', 'true');
  await network.start();
  expect((await network.status()).running).toBe(true);
});

it('reconnects an enabled workspace after its Serve process exits', async () => {
  vi.useFakeTimers();
  await network.setEnabled(true);
  delete route.Foreground.workspace;
  child.exitCode = 1;
  child.emit('exit', 1, null);
  await vi.advanceTimersByTimeAsync(15000);
  expect(start).toHaveBeenCalledTimes(2);
  expect((await network.status()).running).toBe(true);
});
