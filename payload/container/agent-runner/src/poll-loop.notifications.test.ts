import { beforeEach,afterEach,it,expect } from 'bun:test';
import { initTestSessionDb,closeSessionDb,getInboundDb,getOutboundDb } from './mailbox/sqlite/connection.js';
import './mailbox/compose.js';
import { processQuery } from './poll-loop.js';
import type { AgentQuery,ProviderEvent } from './providers/types.js';
beforeEach(()=>{
  initTestSessionDb();
  getInboundDb().exec('CREATE TABLE workspace_context (id INTEGER PRIMARY KEY,value TEXT NOT NULL,control TEXT)');
  getInboundDb().query('INSERT INTO workspace_context VALUES (1,?,NULL)').run(JSON.stringify({title:'Test'}));
  getOutboundDb().exec('CREATE TABLE workspace_events (seq INTEGER PRIMARY KEY AUTOINCREMENT,timestamp TEXT,kind TEXT,content TEXT)');
  getInboundDb().query("INSERT INTO destinations (name,display_name,type,channel_type,platform_id,agent_group_id) VALUES ('web','Web','channel','workspace','web',NULL)").run();
});
afterEach(closeSessionDb);
function run(events:AsyncGenerator<ProviderEvent>,signal?:AbortSignal) {
  const query:AgentQuery={events,push:()=>{},end:()=>{},abort:()=>{}};
  return processQuery(query,{platformId:'web',channelType:'workspace',threadId:null,inReplyTo:'user',taskRun:false},[],'test',undefined,'hello',undefined,false,signal);
}
const terminals=()=>getOutboundDb().query("SELECT content FROM workspace_events WHERE kind='turn-finished'").all().map((r:any)=>JSON.parse(r.content));
it('emits one terminal after durable multi-block output, combining wrapping retries into one logical turn',async()=>{
  await run((async function*(){
    yield {type:'result',text:'unwrapped'} as ProviderEvent;
    yield {type:'result',text:'<message to="web">First</message><message to="web">Second</message>'} as ProviderEvent;
  })());
  const rows=terminals();expect(rows).toHaveLength(1);expect(rows[0].failed).toBe(false);expect(rows[0].ranges).toHaveLength(2);
  const outgoing=getOutboundDb().query("SELECT seq FROM messages_out WHERE kind='chat'").all() as {seq:number}[];
  expect(outgoing).toHaveLength(2);
  expect(rows[0].ranges.at(-1).upto).toBeGreaterThanOrEqual(outgoing.at(-1)!.seq);
});
it('reports a terminal failure when the stream throws, with no diagnostic in the event',async()=>{
  await expect(run((async function*(){throw new Error('PRIVATE_DIAGNOSTIC');yield {type:'result',text:null} as ProviderEvent;})())).rejects.toThrow();
  expect(terminals()).toHaveLength(1);expect(terminals()[0].failed).toBe(true);expect(JSON.stringify(terminals())).not.toContain('PRIVATE_DIAGNOSTIC');
});
it('does not emit a notification terminal for cancellation',async()=>{
  const abort=new AbortController();
  await run((async function*(){abort.abort();yield {type:'result',text:null} as ProviderEvent;})(),abort.signal);
  expect(terminals()).toHaveLength(0);
});
it('turns an error-only stream ending into a final failure instead of a reply',async()=>{
  await run((async function*(){yield {type:'error',message:'private',retryable:false} as ProviderEvent;})());
  expect(terminals()).toHaveLength(1);expect(terminals()[0].failed).toBe(true);
});
