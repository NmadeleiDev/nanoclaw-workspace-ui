import {WorkspaceDocuments,documentEvents} from './documents.js';
import {previewTimeline} from './timeline.js';
import {approvalHistory} from '../approvals/lifecycle.js';
import {parseApprovalComment} from '../approvals/deadlines.js';
import { DEFAULT_SPEECH, SpeechTranscriber, speechAudio, speechStatus, parseSpeech } from './speech.js';
import { getProviderHostContract } from '../../provider-contracts/registry.js';
import { agentModelSettings, updateAgentModelSettings } from '../../agent-model-settings.js';
import { listModelConnections, removeModelConnection, saveModelConnection, seedEnvironmentConnection, parseConnection, ModelSettingsError } from '../../model-connections.js';
import { getGatewayProvider } from '../../gateway-providers/index.js';
import { parseDirectories } from './types.js';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isOwner } from '../permissions/db/user-roles.js';
import { WorkspaceTailnet } from './tailnet.js';
import { WorkspaceAuth } from './auth.js';
import { WorkspaceService } from './service.js';
import { OpenClawImporter } from './openclaw-import.js';
import { inspectDirectories, grantDirectories, browseDirectories } from './directories.js';
import { WorkspaceError, parseProfile, requiredText } from './types.js';

async function body(req: http.IncomingMessage): Promise<Record<string, any>> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new WorkspaceError(415, 'Send JSON.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32 * 1024 * 1024) throw new WorkspaceError(413, 'This request exceeds 32 MB.');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new WorkspaceError(400, 'Invalid JSON object.');
  }
}

export async function startWorkspaceServer(
  service: WorkspaceService,
  port: number,
  staticRoot = path.resolve('web/workspace/dist'),
) {
  if(!(await service.store.db.get('SELECT id FROM ws_settings WHERE id=?','model-connections-imported'))){
    await seedEnvironmentConnection();
    await service.store.db.run('INSERT INTO ws_settings (id,value) VALUES (?,?) ON CONFLICT(id) DO NOTHING','model-connections-imported',new Date().toISOString());
  }
  const speech = new SpeechTranscriber(path.join(service.filesRoot, '.dictation'));
  const documents = new WorkspaceDocuments(service);
  const auth = new WorkspaceAuth(port, service.store.db);
  await service.notifications.start();
  const importer = new OpenClawImporter(service.store, service.filesRoot, () => service.changed());
  // Keep the shell and its hashed assets together for this server's lifetime.
  // A development build must not replace the live UI before its backend restarts.
  const assets = new Map<string, Buffer>();
  if (fs.existsSync(staticRoot)) {
    for (const entry of fs.readdirSync(staticRoot, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = path.join(entry.parentPath, entry.name);
      assets.set(path.relative(staticRoot, file), fs.readFileSync(file));
    }
  }
  const clients = new Set<http.ServerResponse>();
  const notify = () => {
    for (const res of clients) if (!res.destroyed) res.write(`event: change\ndata: {}\n\n`);
  };
  service.events.on('change', notify);
  documentEvents.on('change',notify);
  const server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    const json = (value: unknown, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    void (async () => {
      auth.checkHost(req);
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);
      const route = url.pathname;
      const method = req.method ?? 'GET';
      if (route === '/api/pair' && method === 'POST') {
        auth.checkOrigin(req);
        const request = await body(req);
        return json(await auth.pair(requiredText(request.token, 'Pairing token', 100), res, req));
      }
      if (!route.startsWith('/api/')) {
        if (method !== 'GET' && method !== 'HEAD') throw new WorkspaceError(405, 'Method not allowed.');
        if (
          route !== '/' &&
          !route.startsWith('/assets/') &&
          ![
            '/manifest.webmanifest',
            '/sw.js',
            '/icon.svg',
            '/favicon.ico',
            '/icon-192.png',
            '/icon-512.png',
            '/apple-touch-icon.png',
          ].includes(route)
        )
          throw new WorkspaceError(404, 'Not found.');
        const relative = route === '/' ? 'index.html' : route.slice(1);
        const file = path.resolve(staticRoot, relative);
        const asset = assets.get(path.relative(staticRoot, file));
        if (!file.startsWith(path.resolve(staticRoot) + path.sep) || !asset)
          throw new WorkspaceError(404, 'Workspace assets have not been built. Run pnpm run workspace:build.');
        const mime: Record<string, string> = {
          '.html': 'text/html; charset=utf-8',
          '.js': 'text/javascript',
          '.mjs':'text/javascript',
          '.css': 'text/css',
          '.woff2': 'font/woff2',
          '.svg': 'image/svg+xml',
          '.png': 'image/png',
          '.ico': 'image/x-icon',
          '.webmanifest': 'application/manifest+json',
        };
        res.writeHead(200, { 'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream' });
        if (method === 'HEAD') return res.end();
        res.end(asset);
        return;
      }
      const principal = await auth.authorize(req, !['GET', 'HEAD'].includes(method), res);
      if (!(await isOwner(principal.ownerId))) throw new WorkspaceError(403, 'Owner access has been revoked.');
      const documentRoute=/^\/api\/sessions\/([^/]+)\/documents(?:\/([a-f0-9]+)(\/content)?)?$/.exec(route);
      if(documentRoute){const [,session,id,content]=documentRoute;
        if(method==='POST'&&!id)return json(await documents.open(session,await body(req)));
        if(method==='GET'&&!id)return json({documents:await documents.list(session),requests:await documents.requests(session)});
        if(method==='PUT'&&id){if(!service.bridge)throw new WorkspaceError(403,'Saving working files is disabled in preview.');const input=await body(req);return json(await service.exclusive(`document:${id}`,()=>documents.save(session,id,input.text,input.revision)));}
        if(method==='GET'&&id){if(!content)return json(await documents.read(session,id));const file=await documents.download(session,id);res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`});if(file.fd!==undefined){const stream=fs.createReadStream('',{fd:file.fd,autoClose:true});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);return;}return res.end(file.data);}
      }
      if (route === '/api/speech' && method === 'GET') return json(await speechStatus((await service.store.settings()).speech ?? DEFAULT_SPEECH));
      if (route === '/api/speech/check' && method === 'POST') return json(await speechStatus(parseSpeech(await body(req))));
      if (route === '/api/speech/transcribe' && method === 'POST') {
        if (!service.bridge) throw new WorkspaceError(403, 'Speech input is unavailable in preview.');
        const controller = new AbortController();
        const cancel = () => { if (!res.writableEnded) controller.abort(); };
        res.on('close', cancel);
        try { return json(await speech.transcribe(speechAudio((await body(req)).audio), (await service.store.settings()).speech ?? DEFAULT_SPEECH, controller.signal)); }
        finally { res.off('close', cancel); }
      }
      const agentFileRoute = /^\/api\/agents\/([^/]+)\/(skills|files)(?:\/(content|[a-f0-9]{64}))?$/.exec(route);
      if (agentFileRoute && method === 'GET') {
        let agentId: string;
        try { agentId = decodeURIComponent(agentFileRoute[1]); }
        catch { throw new WorkspaceError(400, 'Invalid agent identifier.'); }
        const agent = await service.workspaceAgent(agentId);
        const [, , resource, file] = agentFileRoute;
        if (resource === 'files') {
          if (!file) return json(service.agentFiles.list(agent));
          if (file !== 'content') throw new WorkspaceError(404, 'Not found.');
          return json(service.agentFiles.read(agent, requiredText(url.searchParams.get('path'), 'File path', 4096)));
        }
        if (file === 'content') throw new WorkspaceError(404, 'Not found.');
        return json(file ? service.skills.detail(agent, file) : service.skills.list(agent));
      }
      if(route === '/api/model-connections' && method === 'GET') return json(await listModelConnections());
      if(route === '/api/model-connections' && ['POST','PATCH'].includes(method)) {
        if(!service.bridge) throw new WorkspaceError(403,'API connections cannot be edited in preview.');
        const input=await body(req);
        const parsed=parseConnection(input);
        const references=await service.store.db.all<{model:string}>('SELECT model FROM ws_sessions WHERE model IS NOT NULL');
        if(references.some(r=>r.model.startsWith(parsed.id+'/')&&!parsed.models.some(m=>r.model===`${parsed.id}/${m.id}`)))throw new WorkspaceError(409,'A model you removed is still selected by a conversation. Update that conversation first.');
        const prepare=async()=>{
          if(!service.bridge?.prepareAgent)throw new WorkspaceError(503,'This host cannot apply connection settings.');
          const agents=await service.store.db.all<{id:string}>("SELECT agent_group_id AS id FROM container_configs WHERE provider='opencode' AND model LIKE ? UNION SELECT agent_id AS id FROM ws_sessions WHERE model LIKE ?",parsed.id+'/%',parsed.id+'/%');
          const releases:Array<()=>void>=[];
          try {for(const agent of agents){const release=await service.bridge.prepareAgent(agent.id);if(release)releases.push(release);}}
          catch(error){for(const release of releases)release();throw error;}
          return ()=>{for(const release of releases)release();};
        };
        const result=await service.exclusive('model-connections',()=>saveModelConnection(input,method==='POST',prepare,async()=>(await service.store.db.all<{model:string}>('SELECT model FROM ws_sessions WHERE model IS NOT NULL')).map(r=>r.model)));
        service.changed();return json(result,method==='POST'?201:200);
      }
      const runnerCredentials=/^\/api\/agents\/([^/]+)\/model-settings\/credentials$/.exec(route);
      if(runnerCredentials && method==='POST'){
        if(!service.bridge)throw new WorkspaceError(403,'Credential handoff is disabled in preview.');
        const agent=await agentModelSettings(runnerCredentials[1]);const input=await body(req);
        if(!agent.providers.includes(input.provider))throw new WorkspaceError(400,'Choose an installed runner.');
        const endpoint=getProviderHostContract(input.provider)?.modelEndpoints?.api;
        if(!endpoint)throw new WorkspaceError(400,'Manage this runner’s credentials from its API connection.');
        const gateway=getGatewayProvider();return json(await gateway.connections?.connect({agentGroupId:agent.id,host:new URL(endpoint).hostname})??{status:'unsupported',message:'Manage credentials in the configured gateway.'});
      }
      const modelAgent=/^\/api\/agents\/([^/]+)\/model-settings$/.exec(route);
      if(modelAgent && method==='GET')return json(await agentModelSettings(modelAgent[1]));
      if(modelAgent && method==='PATCH'){
        if(!service.bridge?.prepareAgent)throw new WorkspaceError(403,'Agent settings cannot be edited in preview.');
        const input=await body(req);
        const old=await agentModelSettings(modelAgent[1]);
        if(typeof input.provider==='string' && input.provider!==old.provider){
          const overrides=await service.store.db.get('SELECT id FROM ws_sessions WHERE agent_id=? AND model IS NOT NULL LIMIT 1',modelAgent[1]);
          const pinned=await service.store.db.get('SELECT id FROM sessions WHERE agent_group_id=? AND agent_provider IS NOT NULL AND agent_provider<>? LIMIT 1',modelAgent[1],input.provider);
          if(overrides||pinned)throw new WorkspaceError(409,'Review this agent’s session model and runner overrides before switching runners. Set session models to Use agent default first.');
        }
        const result=await service.exclusive(`agent-model:${modelAgent[1]}`,()=>updateAgentModelSettings(modelAgent[1],input,()=>service.bridge!.prepareAgent!(modelAgent[1])));
        service.changed();return json(result);
      }
      const connectionDelete=/^\/api\/model-connections\/([^/]+)$/.exec(route);
      if(connectionDelete && method==='DELETE'){
        if(!service.bridge)throw new WorkspaceError(403,'API connections cannot be removed in preview.');
        const id=connectionDelete[1],input=await body(req);
        const refs=await service.store.db.all<{model:string}>('SELECT model FROM ws_sessions WHERE model IS NOT NULL');
        if(refs.some(r=>r.model.startsWith(id+'/')))throw new WorkspaceError(409,'This connection is selected by a conversation. Change that conversation’s model first.');
        await service.exclusive('model-connections',()=>removeModelConnection(id,input.revision,async()=>(await service.store.db.all<{model:string}>('SELECT model FROM ws_sessions WHERE model IS NOT NULL')).map(r=>r.model)));service.changed();return json({ok:true});
      }
      const credentialLink=/^\/api\/model-connections\/([^/]+)\/credentials$/.exec(route);
      if(credentialLink && method==='POST'){
        if(!service.bridge)throw new WorkspaceError(403,'Credential handoff is disabled in preview.');
        const input=await body(req);await agentModelSettings(requiredText(input.agentId,'Agent',200));
        const connection=(await listModelConnections()).find(c=>c.id===credentialLink[1]);
        if(!connection)throw new WorkspaceError(404,'Connection not found.');
        const gateway=getGatewayProvider();
        return json(await gateway.connections?.connect({agentGroupId:input.agentId,host:new URL(connection.endpoint).hostname}) ?? {status:'unsupported',message:'Manage credentials in your configured gateway.'});
      }
      if (route === '/api/devices/current' && method === 'POST') {
        const input = await body(req);
        return json(
          await auth.identify(
            req,
            res,
            requiredText(input.installationId, 'Installation id', 100),
            requiredText(input.name, 'Device name', 80),
          ),
        );
      }
      if (route === '/api/devices' && method === 'GET')
        return json(await service.notifications.devices(principal.ownerId));
      const deviceMatch = /^\/api\/devices\/([^/]+)$/.exec(route);
      if (deviceMatch && method === 'DELETE') {
        await service.notifications.removeDevice(principal.ownerId, deviceMatch[1]);
        return json({ ok: true });
      }
      if (deviceMatch && method === 'PATCH') {
        await service.notifications.updateDevice(principal.ownerId, deviceMatch[1], await body(req));
        return json({ ok: true });
      }
      if (route === '/api/notifications' && method === 'GET')
        return json(await service.notifications.settings(principal.ownerId, principal.deviceId));
      const activityMatch = /^\/api\/notifications\/activity\/([^/]+)$/.exec(route);
      if (activityMatch && method === 'GET') {
        const item = (await service.notifications.activity(principal.ownerId, activityMatch[1])).items[0];
        if (!item) throw new WorkspaceError(404, 'This activity is no longer available.');
        return json(item);
      }
      if (route === '/api/notifications/activity' && method === 'GET')
        return json(await service.notifications.activity(principal.ownerId));
      if (route === '/api/notifications/preferences' && method === 'PATCH') {
        const input = await body(req);
        return json(
          await service.notifications.savePreference(principal.ownerId, input.scope, input.id ?? '', input.preference),
        );
      }
      if (route === '/api/notifications/read' && method === 'POST') {
        const input = await body(req);
        if (input.sessionId !== undefined) requiredText(input.sessionId, 'Session', 200);
        if (input.id !== undefined) requiredText(input.id, 'Activity id', 200);
        await service.notifications.markRead(principal.ownerId, input.sessionId, input.id);
        return json({ ok: true });
      }
      if (route === '/api/notifications/presence' && method === 'POST') {
        await service.notifications.heartbeat(principal.ownerId, principal.deviceId, await body(req));
        return json({ ok: true });
      }
      if (route === '/api/notifications/subscribe' && method === 'POST') {
        if (!service.bridge) throw new WorkspaceError(403, 'Push notifications are disabled in preview.');
        await service.notifications.subscribe(principal.ownerId, principal.deviceId, (await body(req)).subscription);
        return json({ ok: true });
      }
      if (route === '/api/notifications/test' && method === 'POST') {
        if (!service.bridge) throw new WorkspaceError(403, 'Push notifications are disabled in preview.');
        await service.notifications.test(principal.ownerId, requiredText((await body(req)).deviceId, 'Device', 100));
        return json({ ok: true });
      }
      if (route === '/api/me' && method === 'GET') return json(principal);
      if (route === '/api/bootstrap' && method === 'GET')
        return json({ ...(await service.bootstrap()), csrf: principal.csrf, ownerId: principal.ownerId });
      if (route === '/api/events' && method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write('event: change\ndata: {}\n\n');
        clients.add(res);
        const heartbeat = setInterval(() => {
          void (async () => {
            try {
              await auth.authorize(req);
              if (!(await isOwner(principal.ownerId))) return res.end();
              res.write(': heartbeat\n\n');
            } catch {
              res.end();
            }
          })();
        }, 15_000);
        req.on('close', () => {
          clearInterval(heartbeat);
          clients.delete(res);
        });
        return;
      }
      if (route === '/api/projects' && method === 'POST') {
        const p = await service.store.saveProject((await body(req)) as any);
        service.changed();
        return json(p, 201);
      }
      let match = /^\/api\/projects\/([^/]+)$/.exec(route);
      if (match && method === 'PATCH') {
        const previous = await service.store.getProject(match[1]);
        const project = await service.store.saveProject({ ...previous, ...(await body(req)), id: previous.id });
        for (const session of (await service.store.sessions()).filter((s) => s.projectId === project.id))
          await service.syncContext(session);
        service.changed();
        return json(project);
      }
      if (route === '/api/sessions' && method === 'POST')
        return json(await service.createSession((await body(req)) as any), 201);
      match = /^\/api\/sessions\/([^/]+)\/output$/.exec(route);
      if (match && method === 'GET') {
        const session = await service.store.getSession(match[1]);
        const turn = url.searchParams.get('turn');
        const part = url.searchParams.get('part');
        const live = await service.live(session.id);
        let timeline = live?.startedAt === turn ? live.timeline : undefined;
        if (!timeline) {
          const row = await service.store.db.get<{data:string}>('SELECT data FROM ws_messages WHERE session_id=? AND id=?',session.id,`${session.id}:live:${turn}`);
          timeline = row ? JSON.parse(row.data).timeline : undefined;
        }
        const entry = timeline?.find((item:any)=>item.id===part);
        if (!entry) throw new WorkspaceError(404,'Output is no longer available.');
        return json({text:entry.text ?? ''});
      }
      match = /^\/api\/sessions\/([^/]+)$/.exec(route);
      if (match && method === 'GET') {
        const session = await service.store.getSession(match[1]);
        const limit = Number(url.searchParams.get('limit') ?? 100);
        if (!Number.isFinite(limit)) throw new WorkspaceError(400, 'Invalid page size.');
        const history = await service.store.history(session.id, url.searchParams.get('before') ?? undefined, limit);
        const live = await service.live(session.id);
        for (const message of history.messages) if (message.data?.timeline)
          message.data.timeline = previewTimeline(message.data.timeline as any,session.id,String(message.data.startedAt));
        if (live?.timeline) live.timeline = previewTimeline(live.timeline,session.id,live.startedAt);
        return json({
          session,
          ...history,
          live,
          activitySummaries: await service.activitySummaries(session.id, history.messages, live),
          pending: session.nativeSessionId ? await service.pending(session.nativeSessionId) : [],
        });
      }
      if (match && method === 'PATCH') return json(await service.updateSession(match[1], await body(req)));
      match = /^\/api\/sessions\/([^/]+)\/activity-summary$/.exec(route);
      if (match && method === 'POST') {
        const input = await body(req);
        return json(await service.summarizeActivity(match[1], requiredText(input.key, 'Activity block', 1000), input.messageIds));
      }
      match = /^\/api\/sessions\/([^/]+)\/files$/.exec(route);
      if (match && method === 'GET') {
        await service.store.getSession(match[1]);
        return json(
          await service.store.db.all(
            'SELECT id,filename AS name,mime FROM ws_files WHERE session_id=? ORDER BY filename',
            match[1],
          ),
        );
      }
      match = /^\/api\/sessions\/([^/]+)\/messages$/.exec(route);
      if (match && method === 'POST')
        return json(await service.send(match[1], principal.ownerId, (await body(req)) as any));
      match = /^\/api\/sessions\/([^/]+)\/cancel$/.exec(route);
      if (match && method === 'POST') {
        if (!service.bridge) throw new WorkspaceError(503, 'This is an isolated preview.');
        await service.bridge.cancel(await service.store.getSession(match[1]));
        return json({ requested: true });
      }
      match = /^\/api\/documents\/(session|project)\/([^/]+)(\/revisions)?$/.exec(route);
      if (match) {
        const scope = match[1] as 'session' | 'project';
        const id = match[2];
        if (method === 'GET')
          return json(match[3] ? await service.store.revisions(scope, id) : await service.store.document(scope, id));
        if (method === 'PUT' && !match[3]) {
          const request = await body(req);
          const doc = await service.store.saveDocument(
            scope,
            id,
            request.markdown,
            request.revision,
            `human:${principal.ownerId}`,
          );
          for (const session of (await service.store.sessions()).filter((s) =>
            scope === 'session' ? s.id === id : s.projectId === id,
          ))
            await service.syncContext(session);
          service.changed();
          return json(doc);
        }
      }
      if (route === '/api/network' && method === 'GET') return json(await tailnet.status());
      if (route === '/api/network' && method === 'PATCH')
        return json(await tailnet.setEnabled((await body(req)).enabled));
      if (route === '/api/network/pair' && method === 'POST') {
        const link = auth.issue(principal.ownerId, tailnet.url());
        return json({ url: link, code: auth.codeFor(link), expiresInSeconds: 120, codeExpiresInSeconds: 600 });
      }
      if (route === '/api/settings' && method === 'PATCH') {
        const settings = await service.store.saveSettings(await body(req));
        service.changed();
        return json(settings);
      }
      if (route === '/api/utilities/status' && method === 'POST')
        return json(await service.models.status(parseProfile((await body(req)).profile)));
      if (route === '/api/utilities/test' && method === 'POST') {
        const request = await body(req);
        return json({
          text: await service.models.run(parseProfile(request.profile), {
            task: 'title',
            current: '',
            text: 'We are building a local project workspace for NanoClaw. It organizes agent sessions and keeps useful working notes.',
            agentId: request.agentId,
          }),
        });
      }
      if (route === '/api/utilities/refresh' && method === 'POST') {
        const request = await body(req);
        if (!['title', 'session-summary', 'project-summary'].includes(request.task))
          throw new WorkspaceError(400, 'Unknown utility task.');
        if (request.task === 'project-summary') await service.store.getProject(request.id);
        else await service.store.getSession(request.id);
        await service.enqueue(request.id, request.task);
        return json({ queued: true });
      }
      if (route === '/api/search' && method === 'GET')
        return json(
          await service.store.search(url.searchParams.get('q') ?? '', url.searchParams.get('agent') ?? undefined),
        );
      if (route === '/api/directories' && method === 'GET')
        return json(browseDirectories(url.searchParams.get('path') ?? os.homedir()));
      if (route === '/api/directories/inspect' && method === 'POST') {
        const input=await body(req);
        return json(inspectDirectories(input.directories));
      }
      if (route === '/api/directories/grant' && method === 'POST') {
        if (!service.bridge) throw new WorkspaceError(403, 'Folder grants are disabled in the isolated preview.');
        const request = await body(req);
        if (request.confirm !== true) throw new WorkspaceError(400, 'Confirm the exact folder access first.');
        grantDirectories(request.directories);
        return json(inspectDirectories(request.directories));
      }
      if(route==='/api/requests/history' && method==='GET')return json(await approvalHistory(url.searchParams.get('session')??undefined,url.searchParams.get('before')??undefined));
      if (route === '/api/requests' && method === 'GET') return json(await service.pending());
      match = /^\/api\/requests\/([^/]+)\/retry$/.exec(route);
      if(match && method==='POST'){
        const row=await service.store.db.get<any>('SELECT * FROM pending_approvals WHERE approval_id=?',match[1]);
        if(!row || !['rejected','expired'].includes(row.status))throw new WorkspaceError(409,'Only rejected or expired requests can be reconsidered.');
        const session=await service.store.db.get<any>('SELECT id FROM ws_sessions WHERE native_session_id=?',row.session_id);
        if(!session)throw new WorkspaceError(409,'The requesting conversation is no longer available.');
        await service.send(session.id,principal.ownerId,{id:crypto.randomUUID(),text:`Please reconsider approval ${row.approval_id}. Inspect the task's current state and request fresh approval if it is still needed. Do not replay the previous operation automatically.`});
        return json({requested:true},202);
      }
      match = /^\/api\/requests\/([^/]+)$/.exec(route);
      if(match && method==='GET'){const row=await service.store.db.get<any>('SELECT approval_id AS id,title,status,decision_value,application_state,decided_by,decided_at,decision_comment,expires_at FROM pending_approvals WHERE approval_id=?',match[1]);if(!row)throw new WorkspaceError(404,'Approval not found.');return json({request:row,events:await service.store.db.all('SELECT id,kind,created_at FROM approval_events WHERE approval_id=? ORDER BY sequence',match[1])});}
      if (match && method === 'DELETE') return json(await service.dismissExpiredRequest(match[1]));
      if (match && method === 'POST') {
        if (!service.bridge) throw new WorkspaceError(503, 'Approvals cannot be changed in this isolated preview.');
        const response=await body(req);
        const value = requiredText(response.value, 'Response', 10_000);
        let comment:string|undefined;try{comment=parseApprovalComment(response.comment);}catch(e){throw new WorkspaceError(400,(e as Error).message);}
        const id = match[1];
        await service.exclusive(`request:${id}`, () => service.bridge!.respond(principal.ownerId, id, value, comment));
        return json({ resolved: true });
      }
      match = /^\/api\/files\/([a-f0-9]+)$/.exec(route);
      if (match && method === 'GET') {
        const file = await service.file(match[1]);
        const inline =
          url.searchParams.get('inline') === '1' &&
          ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'text/plain'].includes(file.mime);
        res.writeHead(200, {
          'Content-Type': inline ? file.mime : 'application/octet-stream',
          'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
          'Content-Length': file.data.length,
        });
        return res.end(file.data);
      }
      if (route === '/api/import/preview' && method === 'GET')
        return json(importer.preview(url.searchParams.get('root') ?? undefined));
      if (route === '/api/import/progress' && method === 'GET') return json(importer.progress);
      if (route === '/api/import/start' && method === 'POST') {
        const request = await body(req);
        return json(importer.start(requiredText(request.root, 'OpenClaw directory'), request.selections));
      }
      throw new WorkspaceError(404, 'Not found.');
    })().catch((error) => {
      if (res.headersSent) return res.destroy();
      const status =
        error instanceof WorkspaceError || error instanceof ModelSettingsError
          ? error.status
          : error instanceof SyntaxError || error instanceof TypeError
            ? 400
            : 500;
      const code = (error as { code?: string }).code;
      if (code === 'workspace_access_paused') res.setHeader('Retry-After', '5');
      json({ error: error instanceof Error ? error.message : String(error), ...(code === 'workspace_access_paused' ? { code } : {}) }, status);
    });
  });
  server.requestTimeout = 360_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  port = (server.address() as import('node:net').AddressInfo).port;
  auth.port = port;
  const tailnet = new WorkspaceTailnet(
    service.store,
    port,
    (origin, paused) => {
      auth.configureTailnet(origin, paused);
      service.notificationOrigin = origin;
    },
    () => service.changed(),
    !service.bridge,
  );
  await tailnet.start();
  return {
    auth,
    tailnet,
    importer,
    port,
    async close() {
      await tailnet.stop();
      await importer.stop();
      service.events.off('change', notify);
      documentEvents.off('change',notify);
      for (const res of clients) res.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
