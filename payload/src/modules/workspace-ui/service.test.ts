import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { initTestDb, closeDb } from '../../db/connection.js';
import './migration.js';
import { runMigrations } from '../../db/migrations/index.js';
import { WorkspaceStore } from './store.js';
import { WorkspaceService } from './service.js';
import { workspaceConfiguration, workspaceContext } from './context.js';
import { findSessionByAgentGroup } from '../../db/sessions.js';
import { createSession } from '../../db/sessions.js';
import { randomUUID } from 'node:crypto';

let store: WorkspaceStore;
let service: WorkspaceService;
beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(db);
  store = new WorkspaceStore(db);
  await db.run(
    'INSERT INTO agent_groups (id,name,folder,created_at) VALUES (?,?,?,?)',
    'assistant',
    'Assistant',
    'assistant',
    new Date().toISOString(),
  );
  service = new WorkspaceService(store);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await service.stop();
  await closeDb();
});

it('labels a BytePlus endpoint without changing its OpenCode model identifiers', async () => {
  vi.stubEnv('OPENCODE_PROVIDER', 'openai');
  vi.stubEnv('OPENCODE_BASE_URL', 'https://ark.ap-southeast.bytepluses.com/api/coding/v3');
  await store.db.run('INSERT INTO container_configs (agent_group_id,provider,model,updated_at) VALUES (?,?,?,?)',
    'assistant', 'opencode', 'openai/glm-5.2', new Date().toISOString());
  expect((await service.bootstrap()).agents[0]).toMatchObject({
    model: 'openai/glm-5.2', modelProvider: {id:'openai',label:'BytePlus'},
  });
  vi.stubEnv('OPENCODE_BASE_URL', 'https://bytepluses.com.example.test/v1');
  expect((await service.bootstrap()).agents[0].modelProvider).toBeNull();
});

it('updates summaries from completed evidence and protects a concurrent human edit', async () => {
  await store.addSession({ id: 'one', agentId: 'assistant' });
  await store.putMessage({
    id: 'm1',
    sessionId: 'one',
    role: 'assistant',
    kind: 'chat',
    text: 'We chose Plan B.',
    timestamp: '2026-10-27T00:00:00.000Z',
    source: 'web',
    files: [],
  });
  const run = vi.spyOn(service.models, 'run').mockImplementation(async () => {
    await store.saveDocument('session', 'one', 'Human: choose Plan C.', 0, 'human:owner');
    return 'Outdated: Plan B.';
  });
  await service.enqueue('one', 'session-summary');
  await service.work();
  expect((await store.document('session', 'one')).markdown).toBe('Human: choose Plan C.');
  expect(await store.db.get('SELECT state FROM ws_utility_jobs')).toMatchObject({ state: 'pending' });
  run.mockResolvedValue('Human chose Plan C; Plan B is superseded.');
  await store.db.run('UPDATE ws_utility_jobs SET due_at=?', '2020-01-01T00:00:00.000Z');
  await service.work();
  expect((await store.document('session', 'one')).revision).toBe(2);
  expect(run.mock.calls[1][1].current).toBe('Human: choose Plan C.');
  await service.enqueue('one', 'session-summary', '2026-10-27T00:00:00.000Z|m1');
  await service.work();
  expect(run).toHaveBeenCalledTimes(2);
  expect(await store.db.get('SELECT state FROM ws_utility_jobs')).toMatchObject({ state: 'completed' });
});

it('keeps per-session context and utility configuration out of shared agent config', async () => {
  const p = await store.saveProject({ name: 'One', description: 'Ship Plan B.' });
  await store.addSession({
    id: 'one',
    nativeSessionId: 'native',
    agentId: 'assistant',
    projectId: p.id,
    model: 'provider/model',
  });
  await store.saveDocument('session', 'one', 'Session note', 0, 'human:owner');
  await store.saveDocument('project', p.id, 'Shared note', 0, 'human:owner');
  const native = { id: 'native', thread_id: 'system:workspace:one' } as never;
  const base = { additionalMounts: [], mcpServers: { privileged: {} }, skills: ['skill'], model: 'default' } as any;
  const effective = await workspaceConfiguration(store, native, base);
  expect(effective.model).toBe('provider/model');
  expect(base.model).toBe('default');
  expect(effective.workspaceWorkingDirectory).toBe('/workspace/agent');
  expect(JSON.parse((await workspaceContext(store, 'native'))!)).toMatchObject({
    projectBrief: 'Ship Plan B.',
    scratchpad: 'Session note',
    projectScratchpad: 'Shared note',
  });
  const utility = await workspaceConfiguration(store, { thread_id: 'system:workspace-utilities' } as never, base);
  expect(utility).toMatchObject({ workspaceUtility: true, additionalMounts: [], mcpServers: {}, skills: [] });
});

it('never selects a workspace or utility conversation as the shared channel hub', async () => {
  for (const [id, thread, date] of [
    ['chat', null, '2026-01-01'],
    ['web', 'system:workspace:one', '2026-02-01'],
    ['utility', 'system:workspace-utilities', '2026-03-01'],
  ]) {
    await store.db.run(
      'INSERT INTO sessions (id,agent_group_id,thread_id,agent_provider,status,container_status,created_at) VALUES (?,?,?,?,?,?,?)',
      id,
      'assistant',
      thread,
      'claude',
      'active',
      'stopped',
      `${date}T00:00:00.000Z`,
    );
  }
  expect((await findSessionByAgentGroup('assistant'))?.id).toBe('chat');
});

it('refuses a busy runtime change before saving metadata, and serializes changes per session', async () => {
  await store.addSession({ id: 'one', agentId: 'assistant' });
  const reconfigure = vi.fn().mockRejectedValue(new Error('busy'));
  const connected = new WorkspaceService(store, { reconfigure } as any);
  await expect(connected.updateSession('one', { model: 'new' })).rejects.toThrow('busy');
  expect((await store.getSession('one')).model).toBeNull();
  reconfigure.mockResolvedValue(undefined);
  await Promise.all([
    connected.updateSession('one', { model: 'first' }),
    connected.updateSession('one', { model: 'second' }),
  ]);
  expect((await store.getSession('one')).model).toBe('second');
  await connected.stop();
});

it('rejects malformed and oversized combined attachments before sending to the agent', async () => {
  await store.addSession({ id: 'attachment-validation', agentId: 'assistant' });
  const send = vi.fn();
  const connected = new WorkspaceService(store, { send } as any);
  const submit = (attachments: unknown) => connected.send('attachment-validation', 'owner', {
    id: 'attachment-message-001', text: '', attachments: attachments as any,
  });
  await expect(submit([{ name: 'broken.txt', data: '!!!!' }])).rejects.toThrow('could not be read');
  await expect(submit([null])).rejects.toThrow('Attach at most');
  const data = Buffer.alloc(11 * 1024 * 1024).toString('base64');
  await expect(submit([{ name: 'first.bin', data }, { name: 'second.bin', data }])).rejects.toThrow('total 20 MB');
  expect(send).not.toHaveBeenCalled();
  await connected.stop();
});

it('includes a bounded latest chat preview per session without tool or progress output', async () => {
  const agent = await store.db.get<{id:string}>('SELECT id FROM agent_groups LIMIT 1');
  for (const id of ['preview-chat','preview-empty']) await store.addSession({id,agentId:agent!.id});
  const put = (id:string,role:'user'|'assistant'|'tool',kind:string,text:string,timestamp:string) => store.putMessage({id,sessionId:'preview-chat',role,kind,text,timestamp,source:'web',files:[]});
  await put('first','user','chat','Original question','2026-01-01T00:00:00.000Z');
  await put('reply','assistant','chat','## Ready\n\n**Plan** [review](https://example.com)', '2026-01-01T00:01:00.000Z');
  await put('tool','tool','tool-result','Do not use tool output as the preview','2026-01-01T00:02:00.000Z');
  await put('thinking','assistant','thinking','Private progress text','2026-01-01T00:03:00.000Z');
  const sessions=(await service.bootstrap()).sessions;
  expect(sessions.find(s=>s.id==='preview-chat')?.latestMessage).toEqual({role:'assistant',text:'Ready Plan review',sender:null,timestamp:'2026-01-01T00:01:00.000Z'});
  expect(sessions.find(s=>s.id==='preview-empty')?.latestMessage).toBeNull();
  await put('long','assistant','chat','😀'.repeat(3000), '2026-01-01T00:04:00.000Z');
  expect(Array.from((await service.bootstrap()).sessions.find(s=>s.id==='preview-chat')!.latestMessage!.text)).toHaveLength(200);
});

it('previews attachment-only messages, normalizes web senders and resolves timestamp ties consistently', async () => {
  const agent=await store.db.get<{id:string}>('SELECT id FROM agent_groups LIMIT 1');
  await store.addSession({id:'attachment-chat',agentId:agent!.id});
  const timestamp='2026-01-01T00:00:00.000Z';
  for (const [id,text,files] of [['a','Earlier message',[]],['z','',[{ id: 'attachment-id', name: 'notes.txt' }]]] as const)
    await store.putMessage({id,sessionId:'attachment-chat',role:'user',kind:'file',text,timestamp,source:'web',files:[...files],data:{sender:'You · Web'}});
  await store.putMessage({id:'later-empty',sessionId:'attachment-chat',role:'assistant',kind:'chat',text:' \n\t\r ',timestamp:'2026-01-01T00:01:00.000Z',source:'web',files:[]});
  expect((await service.bootstrap()).sessions.find(s=>s.id==='attachment-chat')?.latestMessage).toEqual({role:'user',text:'Attachment',sender:'You',timestamp});
});

it('archives full ordered output including reasoning on terminal events and replays idempotently',async()=>{
 await store.addSession({id:'stream',agentId:'assistant'});
 const rows=[
  {kind:'turn-start',content:'{}'},
  {kind:'text-delta',content:JSON.stringify({id:'r',partType:'reasoning',delta:'x'.repeat(120001)})},
  {kind:'text-delta',content:JSON.stringify({id:'a',partType:'text',delta:'Checking'})},
  {kind:'tool',content:JSON.stringify({id:'tool',name:'read',status:'completed'})},
  {kind:'text-delta',content:JSON.stringify({id:'b',partType:'text',delta:'Done'})},
  {kind:'turn-result',content:'{}'},
 ].map((row,seq)=>({...row,seq,timestamp:`2026-10-29T00:00:0${seq}.000Z`}));
 await (service as any).archiveActivity('stream',rows);
 await (service as any).archiveActivity('stream',rows);
 const result=await store.history('stream');
 expect(result.messages).toHaveLength(1);
 expect((result.messages[0].data?.timeline as any[]).map((e:any)=>e.id)).toEqual(['r','a','tool','b']);
 expect((result.messages[0].data?.timeline as any[])[0].text).toHaveLength(120001);
 await (service as any).applyEvents('stream',rows);
 const live=await service.live('stream');
 expect(live.running).toBe(false);
 expect(live.timeline).toEqual(result.messages[0].data?.timeline);
});
