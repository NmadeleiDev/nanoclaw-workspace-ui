import { registerDeliveryAction } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { getDb } from '../../db/connection.js';
import { writeSessionMessage } from '../../session-manager.js';
import { WorkspaceStore } from './store.js';
import { workspaceContext } from './context.js';
import { withExistingMailboxSession } from '../../session-manager.js';

registerDeliveryAction(
  'workspace_context',
  async (input, session) => {
    const requestId = String(input.requestId);
    if (!/^[a-f0-9-]{36}$/.test(requestId)) throw new Error('Invalid workspace request id.');
    const store = new WorkspaceStore(getDb());
    let data: unknown;
    let error: string | undefined;
    try {
      const current = await store.getSession(session.id);
      if (input.scope === 'reference-history') {
        if (!current.continuedFrom) throw new Error('This session has no reference conversation.');
        data = await store.history(
          current.continuedFrom,
          typeof input.before === 'string' ? input.before : undefined,
          50,
        );
      } else {
        if (input.scope !== 'session' && input.scope !== 'project') throw new Error('Unknown workspace context scope.');
        const id = input.scope === 'session' ? current.id : current.projectId;
        if (!id) throw new Error('This session has no project.');
        data =
          input.markdown === undefined
            ? await store.document(input.scope, id)
            : await store.saveDocument(
                input.scope,
                id,
                String(input.markdown),
                Number(input.revision),
                `agent:${session.agent_group_id}`,
              );
        const affected = (await store.sessions()).filter((s) =>
          input.scope === 'session' ? s.id === current.id : s.projectId === id,
        );
        for (const s of affected) {
          if (!s.nativeSessionId) continue;
          const context = await workspaceContext(store, s.nativeSessionId);
          if (context)
            await withExistingMailboxSession(s.agentId, s.nativeSessionId, (box) => box.setWorkspaceContext?.(context));
        }
      }
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
    await writeSessionMessage(session.agent_group_id, session.id, {
      id: `workspace-response-${requestId}`,
      kind: 'system',
      timestamp: new Date().toISOString(),
      content: JSON.stringify({ type: 'workspace_response', data, error }),
    });
  },
  unguarded(
    'Only reads or revision-updates the calling session’s scratchpads and its explicitly linked reference history; no host paths, credentials, or cross-project targets are accepted.',
  ),
);
