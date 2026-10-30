import type { ProviderEvent } from './types.js';
/** Snapshots replace accumulated deltas; part IDs retain identity across updates. */
export class OpenCodeDisplay {
  private parts = new Map<string, { type: string; text: string; ignored?: boolean }>();
  private excludedMessages = new Set<string>();
  accept(type: string, properties: Record<string, any>): ProviderEvent[] {
    if (type === 'message.updated') {
      const info = properties.info;
      if (info?.role === 'user' || info?.summary) this.excludedMessages.add(`${info.sessionID}:${info.id}`);
      return [];
    }
    const owner = properties.part ?? properties;
    if (this.excludedMessages.has(`${owner.sessionID}:${owner.messageID}`)) return [];
    if (type === 'message.part.updated') {
      const p = properties.part;
      if (!p?.id) return [];
      const id = `${p.sessionID}:${p.messageID}:${p.id}`;
      if (p.type === 'tool') return [{type:'display',kind:'tool',id,data:{name:p.tool,...p.state,sourceSessionId:p.sessionID}}];
      if (!['text','reasoning'].includes(p.type)) return [];
      if (p.synthetic || p.ignored) { this.parts.set(id,{type:p.type,text:'',ignored:true}); return []; }
      this.parts.set(id,{type:p.type,text:p.text ?? ''});
      return [{type:'display',kind:'text-delta',id,data:{text:p.text ?? '',partType:p.type,complete:!!p.time?.end,sourceSessionId:p.sessionID}}];
    }
    if (type !== 'message.part.delta' || properties.field !== 'text' || typeof properties.delta !== 'string') return [];
    const id = `${properties.sessionID}:${properties.messageID}:${properties.partID}`;
    const part = this.parts.get(id);
    if (part?.ignored) return [];
    // Unknown metadata remains explicitly unclassified rather than mislabelled reasoning.
    return [{type:'display',kind:'text-delta',id,data:{delta:properties.delta,partType:part?.type ?? 'output',sourceSessionId:properties.sessionID}}];
  }
}
