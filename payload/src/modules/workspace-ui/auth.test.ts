import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import './migration.js';
import { WorkspaceAuth } from './auth.js';
let auth: WorkspaceAuth;
const remote = 'https://mac.test.ts.net:8443';
const request = (origin = remote) =>
  ({
    headers: { host: new URL(origin).host, origin },
    socket: { remoteAddress: '127.0.0.1' },
  }) as unknown as IncomingMessage;
const response = () => ({ setHeader: vi.fn() }) as unknown as ServerResponse;
beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(db);
  auth = new WorkspaceAuth(3210, db);
  auth.configureTailnet(remote);
});
afterEach(async () => {
  vi.useRealTimers();
  await closeDb();
});
it('allows a manual code after its short-lived link expires, consuming both on success', async () => {
  vi.useFakeTimers();
  const now = Date.now();
  vi.setSystemTime(now);
  const link = auth.issue('owner', remote);
  const token = new URLSearchParams(new URL(link).hash.slice(1)).get('pair')!;
  const code = auth.codeFor(link)!;
  vi.setSystemTime(now + 3 * 60_000);
  await expect(auth.pair(token, response(), request())).rejects.toThrow('link expired');
  await expect(auth.pair(code, response(), request())).resolves.toMatchObject({ ownerId: 'owner', origin: remote });
  await expect(auth.pair(code, response(), request())).rejects.toThrow('expired or was already used');
});
it('expires manual codes after ten minutes', async () => {
  vi.useFakeTimers();
  const now = Date.now();
  vi.setSystemTime(now);
  const link = auth.issue('owner', remote);
  const code = auth.codeFor(link)!;
  vi.setSystemTime(now + 600_001);
  await expect(auth.pair(code, response(), request())).rejects.toThrow('Codes last 10 minutes');
});
it('retains a still-valid code when another link prunes expired short-lived URLs', async () => {
  vi.useFakeTimers();
  const now = Date.now();
  vi.setSystemTime(now);
  const first = auth.issue('owner', remote);
  const code = auth.codeFor(first)!;
  vi.setSystemTime(now + 180_000);
  auth.issue('owner', remote);
  await expect(auth.pair(code, response(), request())).resolves.toMatchObject({ ownerId: 'owner' });
});
it('explains a wrong-address code without accepting or consuming it', async () => {
  const link = auth.issue('owner');
  const code = auth.codeFor(link)!;
  await expect(auth.pair(code, response(), request())).rejects.toThrow('different workspace address');
  await expect(auth.pair(code, response(), request('http://localhost:3210'))).resolves.toMatchObject({
    ownerId: 'owner',
  });
});


it('isolates cookies by port and upgrades a valid legacy login without changing identity',async()=>{
  const other=new WorkspaceAuth(3211,getDb());
  const first=response(),second=response();
  await auth.pair(auth.codeFor(auth.issue('first-owner'))!,first,request('http://localhost:3210'));
  await other.pair(other.codeFor(other.issue('second-owner'))!,second,request('http://localhost:3211'));
  const a=String(vi.mocked(first.setHeader).mock.calls[0][1]).split(';')[0];
  const b=String(vi.mocked(second.setHeader).mock.calls[0][1]).split(';')[0];
  expect(a.split('=')[0]).not.toBe(b.split('=')[0]);
  for(const [service,origin,owner] of [[auth,'http://localhost:3210','first-owner'],[other,'http://localhost:3211','second-owner']] as const){
    const req=request(origin);req.headers.cookie=a+'; '+b;
    expect((await service.authorize(req)).ownerId).toBe(owner);
  }
  const legacy=request('http://localhost:3210');legacy.headers.cookie='nc_workspace='+a.slice(a.indexOf('=')+1);const renewed=response();
  expect((await auth.authorize(legacy,false,renewed)).ownerId).toBe('first-owner');
  expect(String(vi.mocked(renewed.setHeader).mock.calls[0][1])).toMatch(/^nc_workspace_3210=/);
});

it('distinguishes a paused verified host from an unknown host without authorizing either', () => {
  auth.configureTailnet(null, true);
  expect(() => auth.checkHost(request())).toThrow('Remote workspace access is paused');
  try { auth.checkHost(request()); } catch (error) { expect(error).toMatchObject({status:503,code:'workspace_access_paused'}); }
  expect(() => auth.checkHost(request('https://unknown.test:8443'))).toThrow('Invalid workspace host');
  auth.configureTailnet(remote);
  expect(() => auth.checkHost(request())).not.toThrow();
});

it('retains an unconsumed pairing through a temporary verification pause', async () => {
  const link = auth.issue('owner',remote);
  const code = auth.codeFor(link)!;
  auth.configureTailnet(null,true);
  await expect(auth.pair(code,response(),request())).rejects.toMatchObject({status:503});
  auth.configureTailnet(remote);
  await expect(auth.pair(code,response(),request())).resolves.toMatchObject({ownerId:'owner'});
});
