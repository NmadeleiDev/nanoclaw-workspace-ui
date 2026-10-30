import {it,expect} from 'vitest';
import {reduceTimeline,type TimelineEntry} from './timeline.js';
it('preserves sequence, full output, type and tool position across updates and reload',()=>{
 const entries:TimelineEntry[]=[];
 reduceTimeline(entries,'text-delta',{id:'r',partType:'reasoning',delta:'a'.repeat(120000)});
 reduceTimeline(entries,'text-delta',{id:'t',partType:'text',delta:'Checking'});
 reduceTimeline(entries,'tool',{id:'x',name:'shell',status:'running'});
 reduceTimeline(entries,'text-delta',{id:'next',partType:'text',delta:'Done'});
 reduceTimeline(entries,'tool',{id:'x',status:'completed',output:'ok'});
 reduceTimeline(entries,'text-delta',{id:'t',partType:'text',text:'Checking'});
 expect(entries.map(e=>e.id)).toEqual(['r','t','x','next']);
 expect(entries[0].text).toHaveLength(120000);
 expect(entries[1].text).toBe('Checking');
 expect(entries[2].status).toBe('completed');
 expect(JSON.parse(JSON.stringify(entries))).toEqual(entries);
});
