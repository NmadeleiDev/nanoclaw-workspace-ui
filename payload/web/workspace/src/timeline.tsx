import React, {useRef,useEffect,useState} from 'react';
import {workspaceRequest} from './response';
import {timelineText} from './timeline-output';
import ReactMarkdown from 'react-markdown';
import { isTimelineWorkEntry, type TimelineEntry } from '../../../src/modules/workspace-ui/timeline';
export type { TimelineEntry };
function reasoningPreview(text:string) {
  const line=text.replace(/\s+/g,' ').trim();
  return line.length>240 ? line.slice(-240).replace(/^[\p{L}\p{N}]+\s/u,'') : line;
}
function toolPreview(input:unknown):string {
  if(typeof input==='string')return input.replace(/\s+/g,' ').slice(0,200);
  if(!input || typeof input!=='object')return '';
  const record=input as Record<string,unknown>;
  const preview=record.command ?? record.filePath ?? record.path ?? record.url ?? record.query;
  return typeof preview==='string' ? preview.replace(/\s+/g,' ').slice(0,200) : '';
}
function value(input: unknown) { return typeof input === 'string' ? input : JSON.stringify(input,null,2); }
export function OutputTimeline({entries,running=false,delivered=[],toolLabel,toolAction}: {toolLabel?:React.ReactNode;toolAction?:React.ReactNode;entries:TimelineEntry[];running?:boolean;delivered?:string[]}) {
  const remaining=[...delivered];
  const groups: TimelineEntry[][]=[];
  for(const entry of entries) {
    const last=groups.at(-1);
    if(isTimelineWorkEntry(entry) && last && isTimelineWorkEntry(last[0])) last.push(entry); else groups.push([entry]);
  }
  return <div className="output-timeline">{groups.map(group=>isTimelineWorkEntry(group[0]) ? <details className="live-tools" key={group[0].id} open={running}>
    <summary>{toolLabel ?? (running?'Working':'Worked')}{group.some(e=>e.kind==='tool') && <span>{group.filter(e=>e.kind==='tool').length} {group.filter(e=>e.kind==='tool').length===1?'step':'steps'}</span>}</summary>
    {toolAction}
    {group.map(e=>e.kind==='tool' ? <details className="live-tool work-row" key={e.id}><summary><strong>{e.name}</strong><span className="work-preview">{toolPreview(e.input)}</span><small>{e.status}</small></summary><pre>{value(e.input)}</pre>{e.output && <pre>{e.output}</pre>}{e.error && <pre>{e.error}</pre>}</details> : <Reasoning entry={e} running={running} key={e.id}>
      <summary><strong>{e.kind==='reasoning'?(running&&!e.complete?'Thinking':'Reasoning'):'Internal'}</strong><span dir="auto">{reasoningPreview(e.text ?? '')}</span></summary>
    </Reasoning>)}
  </details> : group.map(e=><div className="stream-text" key={e.id}><ReactMarkdown>{timelineText(e.text ?? '',remaining)}</ReactMarkdown></div>))}</div>;
}

function TraceText({text,running}:{text:string;running:boolean}) {
  const ref=useRef<HTMLPreElement>(null);const follow=useRef(true);
  useEffect(()=>{if(running && follow.current && ref.current)ref.current.scrollTop=ref.current.scrollHeight;},[text,running]);
  return <pre dir="auto" ref={ref} onScroll={()=>{const el=ref.current!;follow.current=el.scrollHeight-el.scrollTop-el.clientHeight<24;}}>{text}</pre>;
}

const traceExpansion = new Map<string,boolean>();
function Reasoning({entry,running,children}:{entry:TimelineEntry;running:boolean;children:React.ReactNode}) {
  const [open,setOpen]=useState(()=>traceExpansion.get(entry.id) ?? false);const [full,setFull]=useState<string>();const [error,setError]=useState('');
  useEffect(()=>{
    if(!open || !entry.fullTextUrl)return;
    const controller=new AbortController();
    workspaceRequest<{text:string}>(entry.fullTextUrl,{signal:controller.signal}).then(result=>{setFull(result.text);setError('');}).catch(e=>{if(!controller.signal.aborted)setError(String(e));});
    return ()=>controller.abort();
  },[open,entry.fullTextUrl,entry.text]);
  return <details className="reasoning-trace work-row" open={open} title={entry.sourceSessionId ? `Session ${entry.sourceSessionId}` : undefined} onToggle={e=>{traceExpansion.set(entry.id,e.currentTarget.open);setOpen(e.currentTarget.open);}}>{children}
    {open && <>{error ? <p role="alert">{error}</p> : entry.fullTextUrl && full===undefined ? <p role="status">Loading reasoning…</p> : <TraceText text={entry.fullTextUrl ? full ?? '' : entry.text ?? ''} running={running && !entry.complete} />}</>}
  </details>;
}
