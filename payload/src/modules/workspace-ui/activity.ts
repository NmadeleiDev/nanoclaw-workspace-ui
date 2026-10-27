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
  // Completed native turns are pinned to their last assistant reply, rather than
  // floating below a later user message. Replay order and late delivery are irrelevant.
  const ordered = messages.filter(message=>!message.data?.activityKey);
  for (const activity of messages.filter(message=>message.data?.activityKey)) {
    let anchor = -1;
    for (let i=0;i<ordered.length;i++) {
      const message=ordered[i];
      if (message.role === 'assistant' && !isToolOnly(message) && message.timestamp &&
          message.timestamp >= activity.data!.startedAt && message.timestamp <= activity.data!.endedAt) anchor=i;
    }
    if (anchor >= 0) {
      while (ordered[anchor+1]?.data?.activityKey) anchor++;
      ordered.splice(anchor+1,0,activity);
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
export function activitySources(messages: ActivityMessage[], live: any): Array<{ key: string; evidence: string }> {
  const sources = messageGroups(messages).filter(group => group.every(isToolOnly)).map(group => ({
    key: activityGroupKey(group),
    evidence: group.map(m => JSON.stringify({ tool: m.data?.toolName ?? m.role, text: excerpt(m.text), turnError: m.data?.turnError,
      calls: m.data?.tools?.map((t: any) => ({ name: t.name, input: excerpt(t.input), status: t.status, output: excerpt(t.output), error: excerpt(t.error) })) })).join('\n'),
  }));
  if (live && !live.running && !live.archived && !sources.some(source=>source.key===liveActivityKey(live)) && Object.keys(live.tools ?? {}).length)
    sources.push({ key: liveActivityKey(live), evidence: Object.values(live.tools).map((t: any) => JSON.stringify({
      name: t.name, status: t.status, input: excerpt(t.input), output: excerpt(t.output), error: excerpt(t.error), turnError: live.error,
    })).join('\n') });
  return sources;
}
