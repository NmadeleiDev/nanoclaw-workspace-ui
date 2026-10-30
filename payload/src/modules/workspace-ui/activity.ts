import { isTimelineWorkEntry, type TimelineEntry } from './timeline.js';
/** Shared grouping keeps the summary attached to exactly the tool block shown in chat. */
export interface ActivityMessage {
  id: string; role: string; text: string; files: unknown[];
  timestamp?: string;
  data?: Record<string, any>;
}
export function isToolOnly(message: ActivityMessage) {
  return message.files.length === 0 &&
    (message.role === 'tool' || (message.role === 'assistant' && !message.text.trim() && !!message.data?.tools?.length));
}
export function messageGroups<T extends ActivityMessage>(messages: T[]): T[][] {
  const groups: T[][] = [];
  // A timeline belongs where its turn started, even while later input is queued.
  // Its update/completion timestamp must not move work below that later input.
  // Legacy tool-only archives without a timeline retain their reply anchor.
  const ordered = messages.filter(message=>!message.data?.activityKey);
  for (const activity of messages.filter(message=>message.data?.activityKey)) {
    if (activity.data?.timeline?.length && activity.data.startedAt) {
      const next = ordered.findIndex(message => {
        const timestamp = message.data?.activityKey ? message.data.startedAt ?? message.timestamp : message.timestamp;
        return timestamp && timestamp > activity.data!.startedAt;
      });
      ordered.splice(next < 0 ? ordered.length : next, 0, activity);
      continue;
    }
    let anchor = -1;
    for (let i=0;i<ordered.length;i++) {
      const message=ordered[i];
      if (message.role === 'assistant' && !isToolOnly(message) && message.timestamp &&
          message.timestamp >= activity.data!.startedAt && message.timestamp <= activity.data!.endedAt) anchor=i;
    }
    if (anchor >= 0) {
      while (ordered[anchor+1]?.data?.activityKey) anchor++;
      ordered.splice(activity.data?.timeline?.some((entry:any)=>entry.kind !== 'tool') ? anchor : anchor+1,0,activity);
    } else {
      const next=ordered.findIndex(message=>message.timestamp && message.timestamp > activity.timestamp!);
      ordered.splice(next<0?ordered.length:next,0,activity);
    }
  }
  for (const message of ordered) {
    const last = groups[groups.length - 1];
    if (isToolOnly(message) && !message.data?.activityKey && !last?.[0].data?.activityKey && last?.every(isToolOnly)) last.push(message);
    else groups.push([message]);
  }
  return groups;
}
export const activityGroupKey = (group: ActivityMessage[]) => group[0].data?.activityKey ?? group[0].id;
export const liveActivityKey = (live: { startedAt?: string; updatedAt?: string }) => `live:${live.startedAt ?? live.updatedAt ?? ''}`;
const excerpt = (value: unknown) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  return text.length <= 1200 ? text : `${text.slice(0, 800)}\n[excerpt shortened]\n${text.slice(-400)}`;
};
/** Live and durable turns have the same identity and canonical evidence. */
function nativeEvidence(tools: any[], turnError?: string) {
  return tools.map(tool=>JSON.stringify({name:tool.name,status:tool.status,input:excerpt(tool.input),
    output:excerpt(tool.output),error:excerpt(tool.error),turnError})).join('\n');
}
/** Recognize the former archive envelope without accepting changes to any tool evidence. */
export function sameActivityEvidence(key: string, saved: string, current: string): boolean {
  if (saved === current) return true;
  if (!key.startsWith('live:')) return false;
  const normalize = (text: string) => {
    const rows = text.split('\n').map(line=>JSON.parse(line));
    const tools = rows.length === 1 && rows[0].tool === 'tool' && rows[0].text === '' && Array.isArray(rows[0].calls)
      ? rows[0].calls.map((tool:any)=>({...tool,turnError:rows[0].turnError})) : rows;
    if (!tools.length || tools.some((tool:any)=>typeof tool.name !== 'string')) throw new Error('Invalid activity evidence');
    // Values were already excerpted when saved; do not excerpt them a second time.
    return tools.map((tool:any)=>JSON.stringify({name:tool.name,status:tool.status,input:tool.input,
      output:tool.output,error:tool.error,turnError:tool.turnError})).join('\n');
  };
  try { return normalize(saved) === normalize(current); } catch { return false; }
}
export interface ActivitySource { key: string; evidence: string; count: number; turnKey?: string }
export function activitySources(messages: ActivityMessage[], live: any): ActivitySource[] {
  const sources: ActivitySource[] = messageGroups(messages).filter(group => group.every(isToolOnly)).map(group => ({
    key: activityGroupKey(group), count:group.length,
    evidence: group[0].data?.activityKey
      ? nativeEvidence(group[0].data.tools ?? [],group[0].data.turnError)
      : group.map(m => JSON.stringify({ tool: m.data?.toolName ?? m.role, text: excerpt(m.text), turnError: m.data?.turnError,
        calls: m.data?.tools?.map((t: any) => ({ name: t.name, input: excerpt(t.input), status: t.status, output: excerpt(t.output), error: excerpt(t.error) })) })).join('\n'),
  }));
  if (live && !live.running && !live.waiting && !live.archived && !sources.some(source=>source.key===liveActivityKey(live)) && Object.keys(live.tools ?? {}).length)
    sources.push({key:liveActivityKey(live),count:Object.keys(live.tools).length,evidence:nativeEvidence(Object.values(live.tools),live.error)});
  for (const message of messages) if (message.data?.activityKey && message.data.timeline?.length)
    sources.push(...timelineToolSources(message.data.activityKey,message.data.timeline,message.data.turnError));
  if (live?.timeline?.length && !live.archived) sources.push(...timelineToolSources(liveActivityKey(live),live.timeline,live.error));
  return sources;
}
export const timelineToolGroupKey = (turnKey: string, firstPartId: string) => `${turnKey}:tools:${encodeURIComponent(firstPartId)}`;
export function timelineToolSources(turnKey: string, timeline: TimelineEntry[], turnError?: string): ActivitySource[] {
  const groups: TimelineEntry[][] = [];
  let current: TimelineEntry[] | undefined;
  for (const entry of timeline) {
    if (!isTimelineWorkEntry(entry)) { if (entry.text?.trim()) current = undefined; continue; }
    if (!current) { current=[]; groups.push(current); }
    current.push(entry);
  }
  return groups.map(group=>group.filter(entry=>entry.kind==='tool')).filter(tools=>tools.length).map(tools=>({key:timelineToolGroupKey(turnKey,tools[0].id),turnKey,count:tools.length,evidence:nativeEvidence(tools,turnError)}));
}
