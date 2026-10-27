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
