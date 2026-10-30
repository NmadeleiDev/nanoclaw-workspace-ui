import type { ContainerConfig } from '../../container-config.js';
import type { Session } from '../../types.js';
import { WorkspaceStore } from './store.js';
import { requireDirectories } from './directories.js';

export async function workspaceConfiguration(
  store: WorkspaceStore,
  session: Session,
  base: ContainerConfig,
): Promise<ContainerConfig> {
  if (session.thread_id === 'system:workspace-utilities') {
    return { ...base, additionalMounts: [], mcpServers: {}, skills: [], workspaceUtility: true };
  }
  const metadata = await store.db.get<{ id: string }>(
    'SELECT id FROM ws_sessions WHERE native_session_id=?',
    session.id,
  );
  if (!metadata) return base;
  const work = await store.getSession(metadata.id);
  const directories = requireDirectories(work.directories);
  const mounts = directories.map((d) => ({ hostPath: d.path, containerPath: `ws-${d.id}`, readonly: d.readonly }));
  for (const mount of mounts) {
    if (base.additionalMounts.some((m) => m.containerPath === mount.containerPath))
      throw new Error(`Workspace mount collision: ${mount.containerPath}`);
  }
  return {
    ...base,
    additionalMounts: [...base.additionalMounts, ...mounts],
    ...(work.model ? { model: work.model } : {}),
    ...(work.effort ? { effort: work.effort } : {}),
    workspaceWorkingDirectory: work.primaryDirectoryId
      ? `/workspace/extra/ws-${work.primaryDirectoryId}`
      : '/workspace/agent',
  };
}

export async function workspaceContext(store: WorkspaceStore, sessionId: string): Promise<string | undefined> {
  const metadata = await store.db.get<{ id: string }>(
    'SELECT id FROM ws_sessions WHERE native_session_id=?',
    sessionId,
  );
  if (!metadata) return undefined;
  const work = await store.getSession(metadata.id);
  const project = work.projectId ? await store.getProject(work.projectId) : null;
  const doc = await store.document('session', work.id);
  const projectDoc = project ? await store.document('project', project.id) : null;
  return JSON.stringify({
    version: 1,
    approvalProtocol: 1,
    sessionId: work.id,
    projectId: project?.id ?? null,
    title: work.title,
    projectName: project?.name ?? null,
    projectBrief: project?.description ?? '',
    scratchpad: doc.markdown,
    scratchpadRevision: doc.revision,
    projectScratchpad: projectDoc?.markdown ?? '',
    projectScratchpadRevision: projectDoc?.revision ?? 0,
    directories: work.directories.map((d) => ({
      hostPath: d.path,
      containerPath: `/workspace/extra/ws-${d.id}`,
      readonly: d.readonly,
      primary: d.id === work.primaryDirectoryId,
    })),
    continuedFrom: work.continuedFrom,
  });
}
