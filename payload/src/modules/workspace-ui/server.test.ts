import { registerProviderContainerConfig } from '../../providers/provider-container-registry.js';
import { registerProviderHostContract, getProviderHostContract } from '../../provider-contracts/registry.js';
import '../../provider-contracts/claude.js';
registerProviderContainerConfig('opencode', () => ({}));
registerProviderHostContract('opencode', { ...getProviderHostContract('claude')!, legacyHostAdapter: 'required' });
import '../../providers/index.js';
import { ensureContainerConfig } from '../../db/container-configs.js';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { initTestDb, closeDb } from '../../db/connection.js';
import './migration.js';
import { runMigrations } from '../../db/migrations/index.js';
import { WorkspaceStore } from './store.js';
import { WorkspaceService } from './service.js';
import { startWorkspaceServer } from './server.js';

let store: WorkspaceStore;
let service: WorkspaceService;
let server: Awaited<ReturnType<typeof startWorkspaceServer>>;
let root: string;
let base: string;
let cookie: string;
let csrf: string;
beforeEach(async () => {
  root = fs.mkdtempSync(path.resolve('.cache/workspace-http-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>Workspace</title>');
  fs.mkdirSync(path.join(root, 'assets'));
  fs.writeFileSync(path.join(root, 'assets', 'app-original.js'), 'original-ui');
  const db = await initTestDb();
  await runMigrations(db);
  store = new WorkspaceStore(db);
  await db.run(
    'INSERT INTO users (id,kind,display_name,created_at) VALUES (?,?,?,?)',
    'telegram:owner',
    'telegram',
    'Owner',
    '2026-10-27T00:00:00.000Z',
  );
  await db.run(
    'INSERT INTO user_roles (user_id,role,agent_group_id,granted_at) VALUES (?,?,NULL,?)',
    'telegram:owner',
    'owner',
    '2026-10-27T00:00:00.000Z',
  );
  service = new WorkspaceService(store, undefined, root);
  server = await startWorkspaceServer(service, 0, root);
  base = `http://localhost:${server.port}`;
  const ticket = server.auth.issue('telegram:owner').split('#pair=')[1];
  const pairing = await fetch(`${base}/api/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: ticket }),
  });
  cookie = pairing.headers.get('set-cookie')!.split(';')[0];
  csrf = ((await pairing.json()) as { csrf: string }).csrf;
});
afterEach(async () => {
  await server?.close();
  await service?.stop();
  await closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

it('serves the real protected API through pairing, CSRF, and role checks', async () => {
  expect((await fetch(`${base}/api/bootstrap`)).status).toBe(401);
  expect((await fetch(`${base}/api/bootstrap`, { headers: { Cookie: cookie } })).status).toBe(200);
  const post = (headers: Record<string, string>) =>
    fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ name: 'HTTP project' }),
    });
  expect((await post({})).status).toBe(403);
  expect((await post({ 'X-Workspace-Csrf': csrf, Origin: 'https://hostile.example' })).status).toBe(403);
  const created = await post({ 'X-Workspace-Csrf': csrf, Origin: base });
  expect(created.status).toBe(201);
  expect((await store.projects())[0].name).toBe('HTTP project');
  await store.db.run('DELETE FROM user_roles WHERE user_id=?', 'telegram:owner');
  expect((await fetch(`${base}/api/bootstrap`, { headers: { Cookie: cookie } })).status).toBe(403);
});

it('persists appearance through the protected settings API and rejects invalid presets', async () => {
  const headers = { Cookie: cookie, 'Content-Type': 'application/json', 'X-Workspace-Csrf': csrf };
  const patch = (body: unknown) => fetch(`${base}/api/settings`, { method: 'PATCH', headers, body: JSON.stringify(body) });
  const saved = await patch({ themePreset: 'ember', theme: 'system', ambientMotion: false });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject({ themePreset: 'ember', theme: 'system', ambientMotion: false });
  expect((await patch({ themePreset: 'unknown' })).status).toBe(400);
  const bootstrap = await fetch(`${base}/api/bootstrap`, { headers: { Cookie: cookie } });
  const body = await bootstrap.json() as { settings: unknown };
  expect(body.settings).toMatchObject({ themePreset: 'ember', theme: 'system', ambientMotion: false });
});

it('keeps the running UI intact when another frontend build replaces its files', async () => {
  fs.writeFileSync(path.join(root, 'index.html'), '<title>Requires a newer backend</title>');
  fs.unlinkSync(path.join(root, 'assets', 'app-original.js'));
  fs.writeFileSync(path.join(root, 'assets', 'app-new.js'), 'new-ui');
  const response = await fetch(base);
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('<!doctype html><title>Workspace</title>');
  const original = await fetch(`${base}/assets/app-original.js`);
  expect(original.status).toBe(200);
  expect(await original.text()).toBe('original-ui');
  expect((await fetch(`${base}/assets/app-new.js`)).status).toBe(404);
});

it('consumes pairing tickets once and rejects untrusted Host headers', async () => {
  const token = server.auth.issue('telegram:owner').split('#pair=')[1];
  const pair = () =>
    fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
  expect((await pair()).status).toBe(200);
  expect((await pair()).status).toBe(401);
  const status = await new Promise<number>((resolve, reject) => {
    const req = http.get(
      `${base}/api/bootstrap`,
      { headers: { Cookie: cookie, Host: `malicious.example:${server.port}` } },
      (res) => {
        res.resume();
        resolve(res.statusCode!);
      },
    );
    req.on('error', reject);
  });
  expect(status).toBe(403);
});

it('keeps preview mutations away from live runtime and external folder grants', async () => {
  const headers = { Cookie: cookie, 'Content-Type': 'application/json', 'X-Workspace-Csrf': csrf };
  const grant = await fetch(`${base}/api/directories/grant`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ directories: [], confirm: true }),
  });
  expect(grant.status).toBe(403);
  const chat = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ agentId: 'missing' }),
  });
  expect(chat.status).toBe(503);
  const traversal = await fetch(`${base}/assets/%2e%2e/package.json`, { headers: { Cookie: cookie } });
  expect(traversal.status).toBe(404);
});

it('scopes HTTPS pairing and Secure cookies to the configured tailnet origin and revokes them on disable', async () => {
  const origin = 'https://mac.test.ts.net:8443';
  server.auth.configureTailnet(origin);
  const request = (route: string, method = 'GET', data?: unknown, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: any }>((resolve, reject) => {
      const req = http.request(
        base + route,
        {
          method,
          headers: {
            Host: 'mac.test.ts.net:8443',
            ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...headers,
          },
        },
        (res) => {
          let result = '';
          res.on('data', (chunk) => (result += chunk));
          res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: JSON.parse(result) }));
        },
      );
      req.on('error', reject);
      req.end(data === undefined ? undefined : JSON.stringify(data));
    });
  const token = server.auth.issue('telegram:owner', origin).split('#pair=')[1];
  const paired = await request('/api/pair', 'POST', { token }, { Origin: origin });
  expect(paired.status).toBe(200);
  const remoteCookie = paired.headers['set-cookie']![0];
  expect(remoteCookie).toContain('nc_workspace_tailnet_8443=');
  expect(remoteCookie).toContain('; Secure');
  const headers = { Cookie: remoteCookie.split(';')[0], Origin: origin, 'X-Workspace-Csrf': paired.body.csrf };
  expect((await request('/api/bootstrap', 'GET', undefined, headers)).status).toBe(200);
  expect((await request('/api/projects', 'POST', { name: 'Phone project' }, headers)).status).toBe(201);
  expect(
    (await request('/api/bootstrap', 'GET', undefined, { ...headers, Origin: 'https://attacker.example' })).status,
  ).toBe(403);
  expect((await fetch(base + '/api/bootstrap', { headers: { Cookie: headers.Cookie } })).status).toBe(401);
  server.auth.configureTailnet(null);
  expect((await request('/api/bootstrap', 'GET', undefined, headers)).status).toBe(403);
  expect((await fetch(base + '/api/bootstrap', { headers: { Cookie: cookie } })).status).toBe(200);
});

it('refuses cross-address pairing and tailnet configuration in preview', async () => {
  const origin = 'https://mac.test.ts.net:8443';
  server.auth.configureTailnet(origin);
  const token = server.auth.issue('telegram:owner', origin).split('#pair=')[1];
  expect(
    (
      await fetch(base + '/api/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await fetch(base + '/api/network', {
        method: 'PATCH',
        headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Workspace-Csrf': csrf },
        body: JSON.stringify({ enabled: true }),
      })
    ).status,
  ).toBe(403);
});

it('persists remembered pairing across restarts and supports revocation', async () => {
  // Use independent sockets across the server restart; fetch's global pool can
  // retain a connection closed by the previous listener on the same port.
  const freshFetch = (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    new Promise<Response>((resolve, reject) => {
      const request = http.request(url, { method: init.method, headers: init.headers, agent: false }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode })));
      });
      request.on('error', reject);
      request.end(init.body);
    });
  const me = (await (
    await freshFetch(`${base}/api/me`, { headers: { Cookie: cookie, Connection: 'close' } })
  ).json()) as {
    deviceId: string;
  };
  await server.close();
  server = await startWorkspaceServer(service, server.port, root);
  expect((await freshFetch(`${base}/api/bootstrap`, { headers: { Cookie: cookie, Connection: 'close' } })).status).toBe(
    200,
  );
  expect(
    (
      await freshFetch(`${base}/api/devices/${me.deviceId}`, {
        method: 'PATCH',
        headers: { Cookie: cookie, Connection: 'close', 'Content-Type': 'application/json', 'X-Workspace-Csrf': csrf },
        body: JSON.stringify({ revoked: true }),
      })
    ).status,
  ).toBe(200);
  expect((await freshFetch(`${base}/api/me`, { headers: { Cookie: cookie, Connection: 'close' } })).status).toBe(401);
});
it('pairs using a one-time code and limits invalid attempts', async () => {
  const link = server.auth.issue('telegram:owner');
  const code = server.auth.codeFor(link)!;
  const pair = (token: string) =>
    fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
  expect((await pair(code)).status).toBe(200);
  expect((await pair(code)).status).toBe(401);
  for (let i = 0; i < 9; i++) await pair('WRONG');
  expect((await pair('WRONG')).status).toBe(429);
});
it('splits copied browser cookies into separately revocable installed-device identities', async () => {
  const identify = (installationId: string) =>
    fetch(`${base}/api/devices/current`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Workspace-Csrf': csrf },
      body: JSON.stringify({ installationId, name: 'Browser' }),
    });
  const first = (await (await identify('safari')).json()) as { deviceId: string };
  const copied = await identify('installed-app');
  const second = (await copied.json()) as { deviceId: string };
  expect(second.deviceId).not.toBe(first.deviceId);
  expect(copied.headers.get('set-cookie')).toContain('HttpOnly');
  const rows = await store.db.all('SELECT id FROM ws_devices WHERE revoked_at IS NULL');
  expect(rows).toHaveLength(2);
});
it('protects notification preferences and does not expose push signing or subscription secrets', async () => {
  const headers = { Cookie: cookie, 'Content-Type': 'application/json', 'X-Workspace-Csrf': csrf };
  expect(
    (
      await fetch(`${base}/api/notifications/preferences`, {
        method: 'PATCH',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'global', preference: { mode: 'on' } }),
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await fetch(`${base}/api/notifications/preferences`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ scope: 'global', preference: { mode: 'on' } }),
      })
    ).status,
  ).toBe(200);
  const response = await fetch(`${base}/api/notifications`, { headers: { Cookie: cookie } });
  const text = await response.text();
  expect(text).not.toContain('privateKey');
  expect(text).not.toContain('token_hash');
});

it('serves only the public shell across browser navigation contexts, retaining private API origin checks', async () => {
  const headers = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'empty' };
  const shell = await fetch(base + '/', { headers });
  expect(shell.status).toBe(200);
  expect(shell.headers.get('x-frame-options')).toBe('DENY');
  expect((await fetch(base + '/api/bootstrap', { headers: { ...headers, Cookie: cookie } })).status).toBe(403);
  expect(
    (
      await fetch(base + '/api/pair', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'invalid' }),
      })
    ).status,
  ).toBe(403);
});


it('protects agent skill inventory and detail behind pairing and agent membership in the inventory', async () => {
  await store.db.run('INSERT INTO agent_groups (id,name,folder,created_at) VALUES (?,?,?,?)',
    'skill-agent', 'Skill Agent', 'skill-agent', new Date().toISOString());
  const { WorkspaceSkills } = await import('./skills.js');
  const shared = path.join(root, 'container/skills/welcome');
  fs.mkdirSync(shared, { recursive: true });
  fs.writeFileSync(path.join(shared, 'SKILL.md'), '---\nname: Welcome\ndescription: Welcome aboard.\n---\n# Hello');
  Object.defineProperty(service, 'skills', { value: new WorkspaceSkills(root) });
  const headers = { Cookie: cookie };
  expect((await fetch(`${base}/api/agents/skill-agent/skills`)).status).toBe(401);
  const inventory = await fetch(`${base}/api/agents/skill-agent/skills`, { headers });
  expect(inventory.status).toBe(200);
  const list = await inventory.json() as { skills: { id: string; name: string }[] };
  const welcome = list.skills.find(s => s.name === 'Welcome')!;
  expect(welcome).toBeDefined();
  const detail = await fetch(`${base}/api/agents/skill-agent/skills/${welcome.id}`, { headers });
  expect(detail.status).toBe(200);
  expect(await detail.json()).toMatchObject({ markdown: '# Hello' });
  fs.writeFileSync(path.join(shared, 'SKILL.md'), 'Malformed skill');
  expect((await fetch(`${base}/api/agents/skill-agent/skills/${welcome.id}`, { headers })).status).toBe(409);
  expect((await fetch(`${base}/api/agents/%E0%A4%A/skills`, { headers })).status).toBe(400);
  expect((await fetch(`${base}/api/agents/unknown/skills`, { headers })).status).toBe(404);
  expect((await fetch(`${base}/api/agents/skill-agent/skills/${'0'.repeat(64)}`, { headers })).status).toBe(404);
  expect((await fetch(`${base}/api/agents/skill-agent/skills/%2E%2E%2Fsecret`, { headers })).status).toBe(404);
  await store.db.run('DELETE FROM user_roles WHERE user_id=?', 'telegram:owner');
  expect((await fetch(`${base}/api/agents/skill-agent/skills`, { headers })).status).toBe(403);
});

it('protects connection and agent configuration with owner pairing and CSRF, including previews', async () => {
  expect((await fetch(`${base}/api/model-connections`)).status).toBe(401);
  expect((await fetch(`${base}/api/model-connections`,{headers:{Cookie:cookie}})).status).toBe(200);
  for(const route of ['/api/model-connections','/api/agents/missing/model-settings']){
    const request=(csrfHeader:boolean)=>fetch(base+route,{method:route.endsWith('model-settings')?'PATCH':'POST',headers:{Cookie:cookie,'Content-Type':'application/json',...(csrfHeader?{'X-Workspace-Csrf':csrf}: {})},body:'{}'});
    expect((await request(false)).status).toBe(403);
    expect((await request(true)).status).toBe(403);
  }
});


it('saves an API connection and agent defaults through the paired owner HTTP boundary', async () => {
  const prepareAgent=vi.fn(async()=>{});
  Object.defineProperty(service,'bridge',{value:{prepareAgent}});
  await store.db.run('INSERT INTO agent_groups (id,name,folder,created_at) VALUES (?,?,?,?)','model-agent','Model agent','model-agent',new Date().toISOString());
  await ensureContainerConfig('model-agent','opencode');
  const headers={Cookie:cookie,'Content-Type':'application/json','X-Workspace-Csrf':csrf};
  const call=async(route:string,method:string,input?:unknown)=>fetch(base+route,{method,headers,...(input?{body:JSON.stringify(input)}:{})});
  const connection={id:'test-api',name:'Test API',endpoint:'https://model.example.test/v1',apiType:'openai-compatible',models:[{id:'model',context:32000,output:4096,image:false}]};
  const created=await call('/api/model-connections','POST',connection);expect(created.status).toBe(201);const saved=await created.json() as any;
  const old=await (await call('/api/agents/model-agent/model-settings','GET')).json() as any;
  const input={provider:'opencode',model:'test-api/model',effort:'high',revision:old.revision};
  const updated=await call('/api/agents/model-agent/model-settings','PATCH',input);expect(updated.status).toBe(200);
  expect(prepareAgent).toHaveBeenCalledWith('model-agent');
  expect(await store.db.get('SELECT provider,model,effort FROM container_configs WHERE agent_group_id=?','model-agent')).toMatchObject({provider:'opencode',model:'test-api/model',effort:'high'});
  expect((await call('/api/agents/model-agent/model-settings','PATCH',input)).status).toBe(409);
  expect((await call('/api/model-connections','PATCH',{...saved,models:[{id:'different',context:32000,output:4096,image:false}]})).status).toBe(409);
  expect((await call('/api/model-connections','POST',{...connection,id:'bad',apiKey:'not-a-real-key'})).status).toBe(400);
});

it('serves read-only agent identity and memory files only to paired owners', async () => {
  const { AgentFiles } = await import('./agent-files.js');
  Object.defineProperty(service, 'agentFiles', { value: new AgentFiles(root) });
  await store.db.run('INSERT INTO agent_groups (id,name,folder,created_at) VALUES (?,?,?,?)',
    'file-agent', 'File Agent', 'file-agent', new Date().toISOString());
  const directory = path.join(root, 'groups/file-agent');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'instructions.prepend.md'), '# Identity\n\nHello.');
  const route = `${base}/api/agents/file-agent/files`;
  const headers = { Cookie: cookie };
  expect((await fetch(route)).status).toBe(401);
  const list = await fetch(route, { headers });
  expect(list.status).toBe(200);
  expect(await list.json()).toMatchObject({ files: [{ path: 'instructions.prepend.md', source: 'current' }] });
  const detail = await fetch(`${route}/content?path=instructions.prepend.md`, { headers });
  expect(detail.status).toBe(200);
  expect(await detail.json()).toMatchObject({ markdown: '# Identity\n\nHello.' });
  expect((await fetch(`${route}/content?path=${encodeURIComponent('../other/instructions.prepend.md')}`, { headers })).status).toBe(400);
  expect((await fetch(`${route}/content?path=container.json`, { headers })).status).toBe(400);
  expect((await fetch(`${route}/content?path=memory/missing.md`, { headers })).status).toBe(404);
  expect((await fetch(`${base}/api/agents/unknown/files`, { headers })).status).toBe(404);
  expect((await fetch(`${route}/content?path=instructions.prepend.md`, { method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json', 'X-Workspace-Csrf': csrf }, body: '{}' })).status).toBe(404);
  await store.db.run('DELETE FROM user_roles WHERE user_id=?', 'telegram:owner');
  expect((await fetch(route, { headers })).status).toBe(403);
});

it('requires owner authentication and CSRF to remove an owned disconnected device', async () => {
  const t = new Date().toISOString();
  for (const [id, owner] of [['old-browser', 'telegram:owner'], ['other-browser', 'another-owner']])
    await store.db.run('INSERT INTO ws_devices (id,owner_id,token_hash,origin,name,created_at,last_seen,revoked_at) VALUES (?,?,?,?,?,?,?,?)', id, owner, id, base, 'Old browser', t, t, t);
  expect((await fetch(`${base}/api/devices/old-browser`, { method: 'DELETE' })).status).toBe(401);
  expect((await fetch(`${base}/api/devices/old-browser`, { method: 'DELETE', headers: { Cookie: cookie } })).status).toBe(403);
  const headers = { Cookie: cookie, 'X-Workspace-Csrf': csrf };
  expect((await fetch(`${base}/api/devices/other-browser`, { method: 'DELETE', headers })).status).toBe(404);
  expect((await fetch(`${base}/api/devices/old-browser`, { method: 'DELETE', headers })).status).toBe(200);
  expect(await store.db.get('SELECT id FROM ws_devices WHERE id=?', 'old-browser')).toBeUndefined();
  expect(await store.db.get('SELECT id FROM ws_devices WHERE id=?', 'other-browser')).toEqual({ id: 'other-browser' });
  const active = await store.db.get<{id:string}>('SELECT id FROM ws_devices WHERE owner_id=? AND revoked_at IS NULL', 'telegram:owner');
  expect((await fetch(`${base}/api/devices/${active!.id}`, { method: 'DELETE', headers })).status).toBe(409);
});
