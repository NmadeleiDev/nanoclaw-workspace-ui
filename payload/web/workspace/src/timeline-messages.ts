import {messageGroups,timelineToolGroupKey} from '../../../src/modules/workspace-ui/activity';
import {isTimelineWorkEntry,type TimelineEntry} from '../../../src/modules/workspace-ui/timeline';
interface DisplayMessage {id:string;role:string;text:string;timestamp:string;source:string;kind:string;files:any[];data?:{tools?:Array<{name:string;input:unknown;status?:string;output?:string;error?:string}>;[key:string]:any}}
/** Place delivered message objects (with files and quote IDs) at their stream position. */
export function timelineMessageGroups<T extends DisplayMessage>(messages:T[]):T[][] {
  const ordered=messageGroups(messages).flat();
  const consumed=new Set<string>();
  const replacements=new Map<string,T[]>();
  for(const activity of ordered) {
    const entries:TimelineEntry[]|undefined=activity.data?.timeline;
    if(!entries?.length)continue;
    const replies=messages.filter(m=>m.role==='assistant' && m.timestamp>=activity.data!.startedAt && m.timestamp<=activity.data!.endedAt);
    const result:T[]=[];
    let serial=0;
    const text=(body:string)=>{if(body.trim())result.push({...activity,id:`${activity.id}:text:${serial++}`,role:'assistant',kind:'stream-text',text:body,files:[],data:undefined});};
    const merged:TimelineEntry[]=[];
    for(const entry of entries) {
      const previous=merged.at(-1);
      if(previous && ['text','output'].includes(entry.kind) && previous.kind===entry.kind && previous.sourceSessionId===entry.sourceSessionId)
        previous.text=(previous.text ?? '')+(entry.text ?? '');
      else merged.push({...entry});
    }
    for(const entry of merged) {
      if(isTimelineWorkEntry(entry)) {
        const last=result.at(-1);
        if(last?.data?.timeline?.every(isTimelineWorkEntry)) {
          last.data.timeline.push(entry);
          if(entry.kind==='tool' && !last.data.toolGroupKey) last.data.toolGroupKey=timelineToolGroupKey(activity.data?.activityKey ?? activity.id,entry.id);
        }
        else result.push({...activity,id:`${activity.id}:part:${serial++}`,text:'',files:[],data:{timeline:[entry],running:activity.data?.running,phase:activity.data?.phase,toolGroupKey:entry.kind==='tool' ? timelineToolGroupKey(activity.data?.activityKey ?? activity.id,entry.id) : undefined}});
        continue;
      }
      const raw=entry.text ?? '';let offset=0;
      for(const match of raw.matchAll(/<message\b[^>]*>([\s\S]*?)<\/message>/g)) {
        text(raw.slice(offset,match.index));
        const reply=replies.find(m=>!consumed.has(m.id) && m.text.trim()===match[1].trim());
        if(reply){consumed.add(reply.id);result.push(reply);}else text(match[1]);
        offset=match.index!+match[0].length;
      }
      const tail=raw.slice(offset);
      const open=/<message\b[^>]*>/.exec(tail);
      if(open) {
        text(tail.slice(0,open.index));
        const prefix=tail.slice(open.index+open[0].length).trim();
        // Recover older partial streams only when an explicit delivery block
        // identifies a unique reply from this turn. Ordinary text never matches.
        const matches=prefix ? replies.filter(m=>!consumed.has(m.id) && m.text.trim().startsWith(prefix)) : [];
        if(matches.length===1){consumed.add(matches[0].id);result.push(matches[0]);}
        else text(tail.slice(open.index+open[0].length));
      } else text(tail.replace(/<\/?message\b[^>]*>/g,''));
    }
    if(activity.data?.turnError)result.push({...activity,id:`${activity.id}:error`,role:'system',text:activity.data.turnError,files:[],data:undefined});
    replacements.set(activity.id,result);
  }
  return messageGroups(ordered.flatMap(m=>replacements.get(m.id) ?? (consumed.has(m.id)?[]:[m])));
}

export function withLiveTimeline<T extends DisplayMessage>(messages:T[],live:{archived?:boolean;running:boolean;timeline?:TimelineEntry[];startedAt?:string;updatedAt?:string}|null|undefined,sessionId:string):Array<T | DisplayMessage> {
  if(!live?.timeline?.length || live.archived)return messages;
  return [...messages,{id:`${sessionId}:live:${live.startedAt}`,role:'tool',kind:'activity',text:'',timestamp:live.updatedAt ?? '',source:'agent',files:[],data:{activityKey:`live:${live.startedAt}`,startedAt:live.startedAt,endedAt:live.updatedAt,timeline:live.timeline,running:live.running}}];
}
