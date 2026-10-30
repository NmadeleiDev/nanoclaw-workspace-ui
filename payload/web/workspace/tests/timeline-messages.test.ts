import {it,expect} from 'vitest';
import {timelineMessageGroups,withLiveTimeline} from '../src/timeline-messages';
it('places multiple replies and their attachments between commentary and tools exactly once',()=>{
 const base={timestamp:'2026-10-29T00:00:01Z',source:'agent',kind:'chat',files:[]};
 const one={...base,id:'one',role:'assistant',text:'First',files:[{id:'file'}]};
 const two={...base,id:'two',role:'assistant',text:'Final'};
 const activity={...base,id:'activity',role:'tool',text:'',data:{activityKey:'turn',startedAt:'2026-10-29T00:00:00Z',endedAt:'2026-10-29T00:00:02Z',timeline:[
 {id:'a',kind:'text',text:'Before <message>First</message> Between'},
 {id:'t',kind:'tool',name:'read',status:'completed'},
 {id:'b',kind:'text',text:'After <message>Final</message>'},
 ]}};
 const result=timelineMessageGroups([one,two,activity]).flat();
 expect(result.map(m=>m.text)).toEqual(['Before ','First',' Between','','After ','Final']);
 expect(result[1]).toBe(one);expect(result.at(-1)).toBe(two);
});
it('reassembles delivery wrappers split over adjacent text parts',()=>{
 const message={id:'answer',role:'assistant',text:'Hello',timestamp:'b',source:'agent',kind:'chat',files:[]};
 const activity={...message,id:'activity',role:'tool',text:'',data:{activityKey:'turn',startedAt:'a',endedAt:'c',timeline:[{id:'p1',kind:'text',text:'<mess'},{id:'p2',kind:'text',text:'age>Hello</message>'}]}};
 expect(timelineMessageGroups([message,activity]).flat()).toEqual([message]);
});
it('retains stable per-group summary keys, reasoning classification, and interruption state',()=>{
 const activity={id:'turn',role:'tool',text:'',timestamp:'b',source:'agent',kind:'activity',files:[],data:{activityKey:'live:a',startedAt:'a',endedAt:'b',phase:'interrupted',timeline:[
 {id:'r',kind:'reasoning',text:'Why'},
 {id:'t1',kind:'tool',name:'Read'},
 {id:'t2',kind:'tool',name:'Search'},
 {id:'r2',kind:'reasoning',text:'Next'},
 {id:'t3',kind:'tool',name:'Test'},
 ]}};
 const records=timelineMessageGroups([activity]).flat();
 expect(records.map(m=>m.data?.timeline.length)).toEqual([5]);
 expect(records.filter(m=>m.data?.toolGroupKey).map(m=>m.data?.toolGroupKey)).toEqual(['live:a:tools:t1']);
 expect(records[0].data?.timeline[0].kind).toBe('reasoning');
 expect(records[0].data?.phase).toBe('interrupted');
});
it('replaces a uniquely matched unfinished delivery block with its full delivered message',()=>{
 const reply={id:'reply',role:'assistant',kind:'chat',source:'workspace',text:'Final answer with all remaining content.',timestamp:'b',files:[{id:'attachment'}]};
 const activity={...reply,id:'activity',role:'tool',text:'',files:[],data:{activityKey:'live:a',startedAt:'a',endedAt:'c',timeline:[{id:'partial',kind:'text',text:'Before <message to="workspace">Final answer with'}]}};
 const result=timelineMessageGroups([activity,reply]).flat();
 expect(result.map(m=>m.text)).toEqual(['Before ',reply.text]);expect(result[1]).toBe(reply);
 const plain={...activity,data:{...activity.data,timeline:[{id:'partial',kind:'text',text:'Final answer with'}]}};
 expect(timelineMessageGroups([plain,reply]).flat().map(m=>m.text)).toContain('Final answer with');
});

it('keeps live work ahead of queued messages as tool activity updates',()=>{
 const message=(id:string,timestamp:string)=>({id,role:'user',text:id,timestamp,source:'web',kind:'chat',files:[]});
 const messages=[message('original','01'),message('queued-one','03'),message('queued-two','04')];
 const live={running:true,startedAt:'02',updatedAt:'05',timeline:[{id:'tool',kind:'tool' as const,name:'Read'}]};
 for(const updatedAt of ['02','05','06']) {
  const records=timelineMessageGroups(withLiveTimeline(messages,{...live,updatedAt},'session')).flat();
  expect(records.map(m=>m.role)).toEqual(['user','tool','user','user']);
  expect(records.filter(m=>m.role==='user').map(m=>m.id)).toEqual(['original','queued-one','queued-two']);
 }
});

it('keeps a completed turn and its delivered reply ahead of input queued during it',()=>{
 const base={source:'web',kind:'chat',files:[]};
 const original={...base,id:'original',role:'user',text:'Start',timestamp:'01'};
 const queued={...base,id:'queued',role:'user',text:'Next task',timestamp:'03'};
 const reply={...base,id:'reply',role:'assistant',text:'Done',timestamp:'04'};
 const activity={...base,id:'activity',role:'tool',text:'',timestamp:'05',data:{activityKey:'live:02',startedAt:'02',endedAt:'05',timeline:[
  {id:'tool',kind:'tool',name:'Read'},
  {id:'answer',kind:'text',text:'<message>Done</message>'},
 ]}};
 const next={...activity,id:'next',timestamp:'07',data:{...activity.data,activityKey:'live:06',startedAt:'06',endedAt:'07',timeline:[{id:'next-tool',kind:'tool',name:'Test'}]}};
 for(const activities of [[activity,next],[next,activity]]) {
  const records=timelineMessageGroups([original,queued,reply,...activities]).flat();
  expect(records.map(m=>m.role)).toEqual(['user','tool','assistant','user','tool']);
  expect(records[2]).toBe(reply);
  expect(records[3]).toBe(queued);
 }
});
