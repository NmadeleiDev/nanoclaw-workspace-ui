import { expect, it, beforeEach, afterEach, vi } from 'vitest';
import { activitySources, messageGroups, liveActivityKey } from './activity.js';
import { initTestDb, closeDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import './migration.js';
import { WorkspaceStore } from './store.js';
import { WorkspaceService } from './service.js';
import { UtilityModels, type AgentUtility } from './utility.js';
let store: WorkspaceStore;
let service: WorkspaceService;
const finished = {running:false,startedAt:'2026-10-28T00:00:00.000Z',tools:{a:{name:'Bash',input:'pnpm test',status:'completed',output:'8 tests passed'}},texts:{}};
beforeEach(async()=>{
 const db=await initTestDb();await runMigrations(db);store=new WorkspaceStore(db);service=new WorkspaceService(store);
 await db.run('INSERT INTO agent_groups (id,name,folder,created_at) VALUES (?,?,?,?)','demo','Assistant','demo',new Date().toISOString());
 await store.addSession({id:'chat',agentId:'demo'});
});
afterEach(async()=>{vi.restoreAllMocks();await service.stop();await closeDb();});
const saveLive = (value: unknown)=>store.db.run('INSERT INTO ws_live VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET value=excluded.value','chat',JSON.stringify(value));
const ready=()=>store.db.run("UPDATE ws_utility_jobs SET due_at=? WHERE task='activity-summary'",'2000-01-01T00:00:00.000Z');
it('keeps tool groups separate from conversation text and excludes unfinished live work',()=>{
 const tool={id:'t',role:'tool',text:'Failed: test exited 1',files:[]};
 const messages=[{id:'u',role:'user',text:'Run tests',files:[]},tool,{...tool,id:'t2'},{id:'a',role:'assistant',text:'Tests failed',files:[]}];
 expect(messageGroups(messages).map(g=>g.length)).toEqual([1,2,1]);
 expect(activitySources(messages,{...finished,running:true})).toHaveLength(1);
 expect(activitySources(messages,finished)).toHaveLength(2);
});
it('generates a cached display summary using the selected utility task, without changing scratchpads',async()=>{
 await saveLive(finished);
 const run=vi.spyOn(service.models,'run').mockResolvedValue('Ran the test suite; all eight tests passed.');
 await service.activitySummaries('chat');await ready();await service.work();
 const changed=vi.fn();service.events.on('change',changed);
 const result=await service.activitySummaries('chat');
 expect(result[liveActivityKey(finished)]).toMatchObject({text:'Ran the test suite; all eight tests passed.',state:'completed'});
 expect(run).toHaveBeenCalledOnce();expect(run.mock.calls[0][1]).toMatchObject({task:'activity-summary',current:'',agentId:'demo'});
 expect(changed).not.toHaveBeenCalled();
 expect(await store.db.all('SELECT * FROM ws_scratchpads')).toEqual([]);
});
it('honors automatic-summary disablement but allows an explicit request',async()=>{
 await store.saveSettings({automaticSummaries:false});await saveLive(finished);
 expect(await service.activitySummaries('chat')).toEqual({});
 await service.summarizeActivity('chat',liveActivityKey(finished));
 expect((await store.db.all<any>('SELECT * FROM ws_utility_jobs'))[0]).toMatchObject({state:'pending',task:'activity-summary'});
});
it('does not attach an old result when the activity evidence changes during generation',async()=>{
 await saveLive(finished);await service.activitySummaries('chat');await ready();
 let finish!: (text:string)=>void;
 vi.spyOn(service.models,'run').mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 const work=service.work();
 await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
 await saveLive({...finished,tools:{...finished.tools,b:{name:'Bash',status:'failed',error:'Build failed'}}});
 await service.activitySummaries('chat');finish('An outdated result');await work;
 const rows=await store.db.all<any>('SELECT summary FROM ws_activity_summaries');
 expect(rows[0].summary).toBe('');
});
it('bounds model-generated activity labels and asks for observed results rather than invented success',async()=>{
 const generate=vi.fn<AgentUtility>(async()=> 'Reviewed repository changes and attempted the build, which failed because required configuration was missing. '.repeat(3));
 const result=await new UtilityModels(generate).run({provider:'agent'}, {task:'activity-summary',text:'Bash build: failed',current:''});
 expect(result.length).toBeLessThanOrEqual(180);expect(result.split(/\s+/).length).toBeLessThanOrEqual(24);
 expect(generate.mock.calls[0][2]).toContain('a tool call alone proves no success');
});

it('does not allow summary requests to read tool activity from another session',async()=>{
 await store.addSession({id:'other',agentId:'demo'});
 await store.putMessage({id:'other-tool',sessionId:'other',role:'tool',kind:'tool',text:'Private other activity',timestamp:new Date().toISOString(),source:'test',files:[],data:{}});
 await expect(service.summarizeActivity('chat','other-tool',['other-tool'])).rejects.toThrow('not this conversation');
 expect(await store.db.all('SELECT * FROM ws_activity_summaries')).toEqual([]);
});
it('bounds failed automatic attempts and permits a manual retry without changing the evidence',async()=>{
 await saveLive(finished);await service.activitySummaries('chat');
 const run=vi.spyOn(service.models,'run').mockRejectedValue(new Error('Utility unavailable'));
 for(let attempt=0;attempt<3;attempt++){await ready();await service.work();}
 expect((await service.activitySummaries('chat'))[liveActivityKey(finished)]).toMatchObject({state:'failed'});
 expect(run).toHaveBeenCalledTimes(3);
 await service.activitySummaries('chat');await service.work();expect(run).toHaveBeenCalledTimes(3);
 run.mockResolvedValue('Ran eight tests successfully.');
 await service.summarizeActivity('chat',liveActivityKey(finished));await service.work();
 expect((await service.activitySummaries('chat'))[liveActivityKey(finished)].text).toBe('Ran eight tests successfully.');
});

it('pins a late terminal block after its answer even when a new user message has arrived',()=>{
 const m=(id:string,role:string,timestamp:string,data:any={})=>({id,role,text:role==='assistant'?'Answer':'',files:[],timestamp,data});
 const first=m('a','assistant','02');const user=m('u','user','03');
 const block=m('tools','tool','04',{activityKey:'live:01',startedAt:'01',endedAt:'04',tools:[{name:'Bash'}]});
 expect(messageGroups([first,user,block]).flat().map(m=>m.id)).toEqual(['a','tools','u']);
 expect(activitySources([block],{running:false,startedAt:'01',tools:{x:{name:'Bash'}}})).toHaveLength(1);
});

const archived = (state: typeof finished, id = 'saved-turn') => ({
 id,sessionId:'chat',role:'tool' as const,kind:'activity',text:'',files:[],timestamp:'2026-10-28T00:00:10.000Z',source:'agent',
 data:{activityKey:liveActivityKey(state),startedAt:state.startedAt,endedAt:'2026-10-28T00:00:10.000Z',tools:Object.values(state.tools)},
});
it('uses identical evidence for a completed live turn and its archived tools',()=>{
 expect(activitySources([archived(finished)],null)[0].evidence).toBe(activitySources([],finished)[0].evidence);
});
it('keeps a generated summary after archiving and advancing to a new turn, without generating it again',async()=>{
 await saveLive(finished);
 const run=vi.spyOn(service.models,'run').mockResolvedValue('Verified all eight tests pass.');
 await service.activitySummaries('chat');await ready();await service.work();
 await store.putMessage(archived(finished));
 await saveLive({...finished,running:true,startedAt:'2026-10-28T00:01:00.000Z',tools:{}});
 expect((await service.activitySummaries('chat'))[liveActivityKey(finished)]).toMatchObject({text:'Verified all eight tests pass.',count:1});
 expect(run).toHaveBeenCalledOnce();
});
it('restores summaries saved with the archived wrapper, but rejects changed tool evidence',async()=>{
 const block=archived(finished);await store.putMessage(block);await saveLive({...finished,running:true});
 const evidence=JSON.stringify({tool:'tool',text:'',calls:[{name:'Bash',input:'pnpm test',status:'completed',output:'8 tests passed',error:''}]});
 const {createHash}=await import('node:crypto');const hash=createHash('sha256').update(evidence).digest('hex');
 await store.db.run('INSERT INTO ws_activity_summaries (id,session_id,group_key,source_key,evidence,summary,updated_at) VALUES (?,?,?,?,?,?,?)','legacy','chat',liveActivityKey(finished),hash,evidence,'Verified all eight tests pass.',new Date().toISOString());
 expect((await service.activitySummaries('chat'))[liveActivityKey(finished)]).toMatchObject({text:'Verified all eight tests pass.',count:1});
 await store.db.run('UPDATE ws_messages SET data=? WHERE id=?',JSON.stringify({...block.data,tools:[{...finished.tools.a,output:'Tests failed'}]}),block.id);
 expect((await service.activitySummaries('chat'))[liveActivityKey(finished)]).toBeUndefined();
});

it('reuses a completed archive-envelope cache entry without queuing fresh inference',async()=>{
 const block=archived(finished);await store.putMessage(block);await saveLive(finished);
 const {createHash}=await import('node:crypto');
 const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
 const key=liveActivityKey(finished);const id=hash(`chat:${key}`);
 const evidence=JSON.stringify({tool:'tool',text:'',calls:[{name:'Bash',input:'pnpm test',status:'completed',output:'8 tests passed',error:''}]});
 await store.db.run('INSERT INTO ws_activity_summaries (id,session_id,group_key,source_key,evidence,summary,updated_at) VALUES (?,?,?,?,?,?,?)',id,'chat',key,hash(evidence),evidence,'Verified all eight tests pass.',new Date().toISOString());
 await service.enqueue(id,'activity-summary',hash(evidence),0);
 await store.db.run("UPDATE ws_utility_jobs SET state='completed' WHERE scope_id=?",id);
 const run=vi.spyOn(service.models,'run');
 expect((await service.activitySummaries('chat'))[key]).toMatchObject({text:'Verified all eight tests pass.',state:'completed',count:1});
 await ready();await service.work();expect(run).not.toHaveBeenCalled();
});
it('persists the latest context snapshot across turns and replaces it after compaction',async()=>{
 const apply=(rows:any[]) => (service as any).applyEvents('chat',rows.map((row,index)=>({seq:index+1,timestamp:new Date().toISOString(),content:JSON.stringify(row.data??{}),kind:row.kind})));
 await apply([{kind:'usage',data:{usedTokens:800,contextWindow:1000,model:'example'}}]);
 await apply([{kind:'turn-start'},{kind:'turn-result'}]);
 expect((await service.live('chat')).usage.usedTokens).toBe(800);
 await apply([{kind:'usage',data:{usedTokens:100,contextWindow:1000,model:'example'}}]);
 expect((await new WorkspaceService(store).live('chat')).usage.usedTokens).toBe(100);
 await apply([{kind:'usage',data:{usedTokens:-1,contextWindow:1000}}]);
 expect((await service.live('chat')).usage.usedTokens).toBe(100);
 await apply([{kind:'usage',data:{reset:true}}]);
 expect((await service.live('chat')).usage).toBeUndefined();
});

it.each(['turn-result','turn-cancelled'])('shows compaction as working until %s',async terminal=>{
 const apply=(kind:string,data:object={})=>(service as any).applyEvents('chat',[{seq:1,timestamp:new Date().toISOString(),kind,content:JSON.stringify(data)}]);
 await apply('turn-start');
 expect((await service.live('chat')).running).toBe(true);
 expect((await new WorkspaceService(store).live('chat')).running).toBe(true);
 await apply(terminal,{isError:terminal==='turn-result'});
 expect((await service.live('chat')).running).toBe(false);
});

it('summarizes each consecutive timeline tool group without including reasoning and supports retries by group key',async()=>{
 const state={...finished,timeline:[
  {id:'r',kind:'reasoning',text:'Private reasoning must stay out of utility summaries'},
  {id:'t1',kind:'tool',name:'Read',status:'completed',output:'file read'},
  {id:'t2',kind:'tool',name:'Search',status:'completed',output:'match found'},
  {id:'a',kind:'text',text:'Checking the next step'},
  {id:'t3',kind:'tool',name:'Test',status:'completed',output:'passed'},
 ]};
 await saveLive(state);
 const run=vi.spyOn(service.models,'run').mockResolvedValue('Verified the tools completed.');
 await service.activitySummaries('chat');await ready();await service.work();await service.work();
 const sources=activitySources([],state).filter(s=>s.turnKey);
 expect(sources.map(s=>s.count)).toEqual([2,1]);
 expect(run).toHaveBeenCalledTimes(2);
 expect(run.mock.calls.every(call=>!call[1].text.includes('Private reasoning'))).toBe(true);
 let summaries=await service.activitySummaries('chat');
 for(const source of sources)expect(summaries[source.key]).toMatchObject({text:'Verified the tools completed.',state:'completed',count:source.count});
 // Persisted turns use the same keys and evidence as live output.
 await store.putMessage({id:`chat:${liveActivityKey(state)}`,sessionId:'chat',role:'tool',kind:'activity',text:'',files:[],timestamp:new Date().toISOString(),source:'agent',data:{activityKey:liveActivityKey(state),timeline:state.timeline,tools:Object.values(state.tools)}});
 await store.saveSettings({automaticSummaries:false});
 await service.summarizeActivity('chat',sources[0].key);
 summaries=await service.activitySummaries('chat');
 expect(summaries[sources[0].key].text).toBe('Verified the tools completed.');
});
it('summarizes tools across reasoning traces as one work block without including the reasoning',()=>{
 const state={...finished,timeline:[
  {id:'r1',kind:'reasoning',text:'private thought one'},
  {id:'t1',kind:'tool',name:'Read',output:'read file'},
  {id:'r2',kind:'reasoning',text:'private thought two'},
  {id:'t2',kind:'tool',name:'Search',output:'found match'},
 ]};
 const sources=activitySources([],state).filter(s=>s.turnKey);
 expect(sources).toHaveLength(1);expect(sources[0].count).toBe(2);
 expect(sources[0].key).toBe(`${liveActivityKey(state)}:tools:t1`);
 expect(sources[0].evidence).toContain('Read');expect(sources[0].evidence).toContain('Search');
 expect(sources[0].evidence).not.toContain('private thought');
});


it.each([true, false])('queues completed turns before an immediate next turn (automatic summaries: %s)',async automaticSummaries=>{
 await store.saveSettings({automaticSummaries});
 const events = [
  {kind:'turn-start',timestamp:'2026-10-29T14:51:50.909Z',content:{}},
  {kind:'tool',timestamp:'2026-10-29T14:52:00.000Z',content:{id:'first',name:'Read',status:'completed',output:'First turn evidence'}},
  {kind:'text-delta',timestamp:'2026-10-29T14:52:01.000Z',content:{id:'reply',text:'Checking another step'}},
  {kind:'tool',timestamp:'2026-10-29T14:52:02.000Z',content:{id:'second',name:'Test',status:'completed',output:'Second block evidence'}},
  {kind:'turn-result',timestamp:'2026-10-29T14:58:15.561Z',content:{}},
  {kind:'turn-finished',timestamp:'2026-10-29T14:58:15.564Z',content:{}},
  {kind:'turn-start',timestamp:'2026-10-29T14:58:15.564Z',content:{}},
 ].map((event,index)=>({...event,seq:index+1,content:JSON.stringify(event.content)}));
 await (service as any).archiveActivity('chat',events);
 await (service as any).applyEvents('chat',events);
 expect((await service.live('chat')).running).toBe(true);
 const jobs=await store.db.all<any>("SELECT * FROM ws_utility_jobs WHERE task='activity-summary'");
 expect(jobs).toHaveLength(automaticSummaries ? 2 : 0);
 if (!automaticSummaries) return;
 // Replayed terminal events reuse the same durable jobs.
 await (service as any).archiveActivity('chat',events);
 expect(await store.db.all("SELECT * FROM ws_utility_jobs WHERE task='activity-summary'")).toHaveLength(2);
 const run=vi.spyOn(service.models,'run').mockResolvedValue('Verified completed tool activity.');
 await ready();await service.work();await service.work();
 expect(run).toHaveBeenCalledTimes(2);
 const summaries=await service.activitySummaries('chat');
 expect(Object.values(summaries)).toHaveLength(2);
 for (const summary of Object.values(summaries)) expect(summary).toMatchObject({state:'completed',text:'Verified completed tool activity.'});
});


it.each([false, true])('notifies the owning session as summary work settles (failure: %s)', async failure => {
 await saveLive(finished);
 const changes:any[]=[];service.events.on('change',event=>changes.push(event));
 await service.activitySummaries('chat');
 expect(changes).toContainEqual({sessionId:'chat',metadata:false});
 await ready();
 if(failure) {
  await store.db.run("UPDATE ws_utility_jobs SET attempts=2 WHERE task='activity-summary'");
  vi.spyOn(service.models,'run').mockRejectedValue(new Error('Fixture failure'));
 } else vi.spyOn(service.models,'run').mockResolvedValue('Finished successfully.');
 changes.length=0;await service.work();
 expect(changes).toEqual([{sessionId:'chat',metadata:false},{sessionId:'chat',metadata:false}]);
 const summaries=await service.activitySummaries('chat');
 expect(summaries[liveActivityKey(finished)].state).toBe(failure?'failed':'completed');
});
