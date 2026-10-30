import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { initTestDb, closeDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import './migration.js';
import { WorkspaceStore } from './store.js';
import { WorkspaceService } from './service.js';
import { messageGroups } from './activity.js';
import type { WorkspaceMailboxMessage, WorkspaceMailboxEvent } from '../../mailbox/types.js';
const fake = vi.hoisted(() => ({
  out: [] as WorkspaceMailboxMessage[],
  events: [] as WorkspaceMailboxEvent[],
  limit: 200,
}));
vi.mock('../../session-manager.js', async () => ({
  ...(await vi.importActual('../../session-manager.js')),
  withExistingMailboxSession: async (_a: string, _s: string, fn: (box: any) => unknown) =>
    fn({
      getWorkspaceInbound: () => [],
      getWorkspaceOutbound: (after: number) => fake.out.filter((r) => r.seq > after).slice(0, fake.limit),
      getWorkspaceEvents: (after: number) => fake.events.filter((r) => r.seq > after),
    }),
}));
let store: WorkspaceStore;
let service: WorkspaceService;
beforeEach(async () => {
  fake.out = [];
  fake.events = [];
  fake.limit = 200;
  const db = await initTestDb();
  await runMigrations(db);
  store = new WorkspaceStore(db);
  service = new WorkspaceService(store);
  await db.run('UPDATE ws_settings SET value=? WHERE id=?', '2000-01-01T00:00:00.000Z', 'notification-baseline');
  await db.run(
    'INSERT INTO agent_groups (id,name,folder,created_at) VALUES (?,?,?,?)',
    'agent',
    'Agent',
    'agent',
    new Date().toISOString(),
  );
  await db.run(
    'INSERT INTO sessions (id,agent_group_id,thread_id,status,container_status,created_at) VALUES (?,?,?,?,?,?)',
    's',
    'agent',
    'system:workspace:s',
    'active',
    'running',
    new Date().toISOString(),
  );
  await store.addSession({ id: 's', nativeSessionId: 's', agentId: 'agent' });
  await service.notifications.start();
});
afterEach(async () => {
  await service.stop();
  await closeDb();
});
const message = (id: string, seq: number, text: string): WorkspaceMailboxMessage => ({
  id,
  seq,
  timestamp: new Date().toISOString(),
  kind: 'chat',
  content: JSON.stringify({ text }),
  channel_type: 'workspace',
});
const terminal = (seq: number, id: string, ranges: unknown[], failed = false): WorkspaceMailboxEvent => ({
  seq,
  timestamp: new Date().toISOString(),
  kind: 'turn-finished',
  content: JSON.stringify({ id, ranges, failed }),
});
it('waits for all referenced outbound rows before checkpointing, then records exactly one activity', async () => {
  fake.limit = 1;
  fake.out = [message('a', 1, 'First'), message('b', 3, 'Second')];
  fake.events = [terminal(1, 'turn', [{ after: 0, upto: 3 }])];
  const session = await store.getSession('s');
  await service.collect(session);
  expect(await store.db.all('SELECT id FROM ws_activity')).toHaveLength(0);
  await service.collect(session);
  await service.collect(session);
  const rows = await store.db.all<{ text: string; message_id: string }>('SELECT text,message_id FROM ws_activity');
  expect(rows).toHaveLength(1);
  expect(rows[0]).toEqual({ text: 'First Second', message_id: 's:out:b' });
});
it('combines only its logical turn ranges, excluding an interleaved follow-up and external destinations', async () => {
  fake.out = [
    message('a', 1, 'Original'),
    message('other', 3, 'Other turn'),
    message('retry', 5, 'Retry'),
    { ...message('elsewhere', 7, 'External'), channel_type: 'slack' },
  ];
  fake.events = [
    terminal(1, 'original', [
      { after: 0, upto: 1 },
      { after: 3, upto: 7 },
    ]),
  ];
  await service.collect(await store.getSession('s'));
  expect(await store.db.get('SELECT text FROM ws_activity')).toEqual({ text: 'Original Retry' });
});
it('records a failure without raw diagnostics or requiring a chat message', async () => {
  fake.events = [terminal(1, 'failure', [], true)];
  await service.collect(await store.getSession('s'));
  expect(await store.db.get('SELECT kind,text FROM ws_activity')).toMatchObject({
    kind: 'failure',
    text: expect.stringContaining('could not finish'),
  });
});

it('retains completed turns in timeline order across new turns', async () => {
  const time=(n:number)=>`2026-10-28T01:00:${String(n).padStart(2,'0')}.000Z`;
  const event=(seq:number,kind:string,data:any={})=>({seq,kind,timestamp:time(seq),content:JSON.stringify(data)});
  fake.events=[event(1,'turn-start'),event(2,'tool',{id:'t1',name:'Bash',status:'completed',input:'test',output:'passed'}),event(4,'turn-result')];
  fake.out=[{...message('a1',1,'First answer'),timestamp:time(3)}];
  const session=await store.getSession('s');
  await service.collect(session);
  expect(await service.live('s')).toMatchObject({running:false,archived:true});
  await store.putMessage({id:'u2',sessionId:'s',role:'user',kind:'chat',text:'Next question',timestamp:time(5),source:'web',files:[]});
  let history=(await store.history('s')).messages;
  expect(messageGroups(history).flat().map(m=>m.data?.activityKey?'activity':m.id)).toEqual(['activity','s:out:a1','u2']);
  fake.events.push(event(6,'turn-start'),event(7,'tool',{id:'t2',name:'Read',status:'completed',output:'brief'}),event(9,'turn-result'));
  fake.out.push({...message('a2',3,'Second answer'),timestamp:time(8)});
  await service.collect(session);await service.collect(session);
  history=(await store.history('s')).messages;
  expect(messageGroups(history).flat().map(m=>m.data?.activityKey?'activity':m.id)).toEqual(['activity','s:out:a1','u2','activity','s:out:a2']);
  const blocks=history.filter(m=>m.data?.activityKey);
  expect(blocks).toHaveLength(2);expect((blocks[0].data?.tools as any[])[0].output).toBe('passed');
  await service.summarizeActivity('s',String(blocks[0].data!.activityKey));
  expect((await store.db.all<any>("SELECT evidence FROM ws_activity_summaries WHERE group_key=?",blocks[0].data!.activityKey))[0].evidence).toContain('passed');
});
it('backfills retained events independently of existing live and notification cursors',async()=>{
  const time=(n:number)=>`2026-10-28T02:00:${String(n).padStart(2,'0')}.000Z`;
  fake.events=[{seq:1,kind:'turn-start',timestamp:time(1),content:'{}'},
    {seq:2,kind:'tool',timestamp:time(2),content:JSON.stringify({id:'t',name:'Bash',status:'completed'})},
    {seq:3,kind:'turn-result',timestamp:time(3),content:'{}'}];
  await store.db.run("INSERT INTO ws_cursors VALUES ('s','event',99)");
  await store.db.run("INSERT INTO ws_notification_cursors VALUES ('s',99)");
  await store.db.run('INSERT INTO ws_live VALUES (?,?)','s',JSON.stringify({running:true,startedAt:time(10),tools:{},texts:{}}));
  await service.collect(await store.getSession('s'));
  expect((await store.history('s')).messages.filter(m=>m.data?.activityKey)).toHaveLength(1);
  expect(await service.live('s')).toMatchObject({running:true,startedAt:time(10)});
});

it('restores an activity turn split across batches and retains cancellation details',async()=>{
  fake.events=[{seq:1,kind:'turn-start',timestamp:'2026-10-28T03:00:01.000Z',content:'{}'},
    {seq:2,kind:'tool',timestamp:'2026-10-28T03:00:02.000Z',content:JSON.stringify({id:'t',name:'Bash',status:'failed',error:'Cancelled command'})}];
  const session=await store.getSession('s');await service.collect(session);
  expect((await store.history('s')).messages).toHaveLength(0);
  // A fresh service reads the durable replay state, independently of in-memory state.
  await service.stop();service=new WorkspaceService(store);
  fake.events.push({seq:3,kind:'turn-cancelled',timestamp:'2026-10-28T03:00:03.000Z',content:'{}'});
  await service.collect(session);
  const block=(await store.history('s')).messages[0];
  expect((block.data?.tools as any[])[0]).toMatchObject({status:'failed',error:'Cancelled command'});
  expect(await service.live('s')).toMatchObject({running:false,archived:true});
});

it('discovers task sessions and collects their replies and notifications exactly once', async () => {
  await service.stop();
  service = new WorkspaceService(store, {} as any);
  await service.notifications.start();
  for (const [id, thread] of [['task', 'system:tasks:reminder'], ['internal', 'system:utility:summary']]) {
    await store.db.run(
      'INSERT INTO sessions (id,agent_group_id,thread_id,status,container_status,created_at) VALUES (?,?,?,?,?,?)',
      id, 'agent', thread, 'closed', 'stopped', new Date().toISOString(),
    );
  }
  fake.out = [message('reminder', 1, 'Scheduled reminder')];
  fake.events = [terminal(1, 'reminder-turn', [{ after: 0, upto: 1 }])];
  await service.tick();
  await service.tick();
  expect((await store.history('task')).messages.filter(m => m.role === 'assistant').map(m => m.text)).toEqual(['Scheduled reminder']);
  expect(await store.db.all("SELECT text FROM ws_activity WHERE session_id='task'")).toEqual([{ text: 'Scheduled reminder' }]);
  expect(await store.db.get("SELECT id FROM ws_sessions WHERE id='internal'")).toBeUndefined();
});

it('archives interrupted tools once when a runtime ends without a terminal event', async () => {
  await store.db.run("UPDATE sessions SET container_status='stopped' WHERE id='s'");
  const state = {running:true, startedAt:new Date().toISOString(), tools:{a:{id:'a',name:'bash',status:'completed',output:'kept'},b:{id:'b',name:'bash',status:'running'}},texts:{a:'<message>partial</message>'}};
  await store.db.run('INSERT INTO ws_live(session_id,value) VALUES (?,?)','s',JSON.stringify(state));
  await service.collect(await store.getSession('s'));
  const live = await service.live('s');
  expect(live.running).toBe(false);
  expect(live.tools.a.output).toBe('kept');
  expect(live.tools.b.status).toBe('interrupted');
  expect(live.texts.a).toBe('<message>partial</message>');
  await service.collect(await store.getSession('s'));
  const history = await store.history('s');
  expect(history.messages.filter(m => m.kind === 'activity')).toHaveLength(1);
  expect(history.messages.find(m => m.kind === 'activity')?.data).toMatchObject({partialText:'partial',phase:'interrupted'});
});
