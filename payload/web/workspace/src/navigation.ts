export type WorkspaceNavigation = { agentId: string; projectId: string | null; sessionId: string | null };
type NavigationData = {
  agents: { id: string }[];
  projects: { id: string }[];
  sessions: { id: string; agentId: string; projectId: string | null }[];
};

export function resolveNavigation(href: string, data: NavigationData, remembered?: WorkspaceNavigation): WorkspaceNavigation {
  const query = new URL(href).searchParams;
  const explicit = ['agent', 'project', 'session'].some(key => query.has(key));
  const sessionId = explicit ? query.get('session') : remembered?.sessionId;
  const session = data.sessions.find(item => item.id === sessionId);
  // A conversation owns its agent and project, even if a link contains conflicting IDs.
  if (session && data.agents.some(agent => agent.id === session.agentId))
    return { agentId: session.agentId, projectId: session.projectId, sessionId: session.id };
  const candidate = explicit ? query.get('agent') : remembered?.agentId;
  const agentId = data.agents.find(agent => agent.id === candidate)?.id ?? data.agents[0]?.id ?? '';
  const project = query.get('project');
  return { agentId, projectId: !sessionId && data.projects.some(item => item.id === project) ? project : null, sessionId: null };
}

export function navigationKey(state: WorkspaceNavigation): string {
  return JSON.stringify([state.agentId, state.sessionId ? null : state.projectId, state.sessionId]);
}

export function navigationUrl(href: string, state: WorkspaceNavigation): string {
  const url = new URL(href);
  for (const key of ['agent', 'project', 'session']) url.searchParams.delete(key);
  if (state.agentId) url.searchParams.set('agent', state.agentId);
  if (state.sessionId) url.searchParams.set('session', state.sessionId);
  else if (state.projectId) url.searchParams.set('project', state.projectId);
  return url.href;
}
