export interface TimelineEntry {
  id: string; kind: 'text' | 'reasoning' | 'output' | 'tool'; text?: string;
  name?: string; status?: string; input?: unknown; output?: string; error?: string;
  fullTextUrl?: string; complete?: boolean; sourceSessionId?: string;
}
/** Mailbox sequence establishes order; updates never move an existing entry. */
export function reduceTimeline(entries: TimelineEntry[], kind: string, data: Record<string, any>): void {
  if (kind !== 'text-delta' && kind !== 'tool') return;
  let entry = entries.find(e => e.id === data.id);
  if (!entry) { entry = {id:data.id,kind:kind === 'tool' ? 'tool' : 'output'}; entries.push(entry); }
  if (kind === 'tool') Object.assign(entry,data,{kind:'tool'});
  else {
    entry.kind = data.partType === 'reasoning' ? 'reasoning' : data.partType === 'text' ? 'text' : entry.kind;
    entry.text = typeof data.text === 'string' ? data.text : (entry.text ?? '') + (data.delta ?? '');
    entry.complete = data.complete ?? entry.complete;
    entry.sourceSessionId = data.sourceSessionId;
  }
}

/** Large reasoning stays durable; collapsed responses carry only the running tail. */
export function previewTimeline(entries: TimelineEntry[], sessionId: string, turn: string): TimelineEntry[] {
  return entries.map(entry => entry.kind === 'reasoning' && (entry.text?.length ?? 0)>4000
    ? {...entry,text:entry.text!.slice(-4000),fullTextUrl:`/api/sessions/${encodeURIComponent(sessionId)}/output?turn=${encodeURIComponent(turn)}&part=${encodeURIComponent(entry.id)}`}
    : entry);
}

/** Reasoning belongs to the work it accompanies; user-facing text separates work blocks. */
export function isTimelineWorkEntry(entry: TimelineEntry): boolean {
  return entry.kind === 'tool' || entry.kind === 'reasoning' || /<internal\b/.test(entry.text ?? '');
}
