type Agent = { id: string; name?: string };
const normalized = (value?: string) =>
  (value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
/** Ambiguous imports need an explicit choice; a main agent has no special owner. */
export function matchImportAgents(source: Agent[], target: Agent[]): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const agent of source) {
    const exactId = target.filter((candidate) => candidate.id === agent.id);
    const names = new Set([normalized(agent.id), normalized(agent.name)].filter(Boolean));
    const candidates = exactId.length ? exactId : target.filter((candidate) => names.has(normalized(candidate.name)));
    if (candidates.length === 1) mapping[agent.id] = candidates[0].id;
  }
  return mapping;
}
