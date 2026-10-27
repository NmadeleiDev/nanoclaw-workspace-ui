import { resolveProviderName } from '../../providers/provider-name.js';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { getDb } from '../../db/connection.js';
import {
  createMessagingGroupIfAbsent,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
} from '../../db/messaging-groups.js';
import { getSession, createSession, findSystemSession } from '../../db/sessions.js';
import {
  resolveSession,
  initSessionFolder,
  withExistingMailboxSession,
  writeSessionMessage,
  withMailboxSession,
} from '../../session-manager.js';
import { requestWake } from '../../request-wake.js';
import { routeOperatorMessage } from '../../router.js';
import { getResponseHandlers, markOperatorResponse } from '../../response-registry.js';
import { finalizeReject } from '../approvals/finalize.js';
import { isAuthorizedApprovalClick } from '../approvals/response-handler.js';
import { WorkspaceError, type WorkspaceSession } from './types.js';
import type { AgentUtility } from './utility.js';

export interface WorkspaceBridge {
  create(agentId: string, runtimeDriver?: string): Promise<string>;
  send(session: WorkspaceSession, ownerId: string, messageId: string, content: string): Promise<unknown>;
  cancel(session: WorkspaceSession): Promise<void>;
  reconfigure(session: WorkspaceSession): Promise<void>;
  prepareAgent?(agentId: string): Promise<void | (() => void)>;
  respond(ownerId: string, id: string, value: string): Promise<void>;
  agentUtility?: AgentUtility;
}

export function hostBridge(): WorkspaceBridge {
  return {
    async create(agentId, runtimeDriver) {
      const mgId = `workspace-${agentId}`;
      const timestamp = new Date().toISOString();
      await createMessagingGroupIfAbsent({
        id: mgId,
        channel_type: 'workspace',
        instance: 'workspace',
        platform_id: agentId,
        name: 'Workspace',
        is_group: 1,
        unknown_sender_policy: 'strict',
        created_at: timestamp,
      });
      if (!(await getMessagingGroupAgentByPair(mgId, agentId))) {
        await createMessagingGroupAgent({
          id: randomUUID(),
          messaging_group_id: mgId,
          agent_group_id: agentId,
          engage_mode: 'pattern',
          engage_pattern: '.',
          sender_scope: 'known',
          ignored_message_policy: 'drop',
          session_mode: 'per-thread',
          threads: 1,
          priority: 0,
          created_at: timestamp,
        });
      }
      if (runtimeDriver && runtimeDriver !== 'docker') throw new WorkspaceError(400, 'This add-on supports Docker sessions.');
      const { session } = await resolveSession(agentId, mgId, `system:workspace:${randomUUID()}`, 'per-thread');
      return session.id;
    },
    async send(session, ownerId, id, content) {
      if (!session.nativeSessionId)
        throw new WorkspaceError(409, 'Continue this imported conversation in NanoClaw first.');
      return routeOperatorMessage(session.nativeSessionId, ownerId, {
        id,
        content,
        timestamp: new Date().toISOString(),
      });
    },
    async cancel(session) {
      if (!session.nativeSessionId) throw new WorkspaceError(400, 'Imported conversations have no running turn.');
      await withMailboxSession(session.agentId, session.nativeSessionId, (box) => {
        if (!box.setWorkspaceControl)
          throw new WorkspaceError(501, 'The installed mailbox does not support workspace controls.');
        box.setWorkspaceControl(JSON.stringify({ kind: 'cancel', at: new Date().toISOString() }));
      });
    },
    async reconfigure(session) {
      if (!session.nativeSessionId) return;
      const busy = await withExistingMailboxSession(
        session.agentId,
        session.nativeSessionId,
        (box) => box.getProcessingClaims().length > 0,
      );
      if (busy) throw new WorkspaceError(409, 'Let the current turn finish before changing its runtime settings.');
      const { isContainerRunning, killContainer } = await import('../../container-runner.js');
      if (isContainerRunning(session.nativeSessionId)) {
        const token = randomUUID();
        await withMailboxSession(session.agentId, session.nativeSessionId, (box) =>
          box.setWorkspaceControl?.(JSON.stringify({ kind: 'reconfigure', id: token })),
        );
        const deadline = Date.now() + 10_000;
        let ready = false;
        while (Date.now() < deadline && isContainerRunning(session.nativeSessionId)) {
          const acknowledged = await withExistingMailboxSession(session.agentId, session.nativeSessionId, (box) =>
            box.getWorkspaceState?.('ws.reconfigure-ready'),
          );
          if (acknowledged === token) {
            ready = true;
            break;
          }
          await delay(100);
        }
        if (!ready && isContainerRunning(session.nativeSessionId)) {
          await withMailboxSession(session.agentId, session.nativeSessionId, (box) => box.setWorkspaceControl?.('{}'));
          throw new WorkspaceError(
            409,
            'The runner did not acknowledge a safe settings change. Finish the turn, or update and restart the runner before retrying.',
          );
        }
        await new Promise<void>((resolve, reject) => {
          const timeout=setTimeout(()=>reject(new WorkspaceError(503,'The previous runner has not finished cleanup. Settings were not saved; wait for cleanup and retry.')),20_000);
          killContainer(session.nativeSessionId!, 'workspace-session-settings', ()=>{clearTimeout(timeout);resolve();});
        });
        await withMailboxSession(session.agentId, session.nativeSessionId, (box) => box.setWorkspaceControl?.('{}'));
      }
    },
    async prepareAgent(agentId) {
      const {beginAgentConfiguration,isContainerRunning}=await import('../../container-runner.js');
      const pause=beginAgentConfiguration(agentId);
      if(!pause)throw new WorkspaceError(409,'Another settings change is in progress for this agent.');
      try {
        const sessions = await getDb().all<{id:string}>('SELECT id FROM sessions WHERE agent_group_id=?', agentId);
        await pause.settle(sessions.map(s=>s.id));
        for (const session of sessions) {
          if(!isContainerRunning(session.id))continue;
          const busy = await withExistingMailboxSession(agentId, session.id, box => box.getProcessingClaims().length > 0);
          if (busy) throw new WorkspaceError(409, 'Let this agent’s current turns finish before changing its model or runner.');
        }
        for (const session of sessions) if(isContainerRunning(session.id)) await this.reconfigure({nativeSessionId: session.id, agentId} as WorkspaceSession);
        return pause.release;
      } catch(error) { pause.release();throw error; }
    },
    async respond(ownerId, id, value) {
      const db = getDb();
      const approval = await db.get<any>('SELECT * FROM pending_approvals WHERE approval_id=?', id);
      const question = approval
        ? undefined
        : await db.get<any>('SELECT * FROM pending_questions WHERE question_id=?', id);
      if (!approval && !question) throw new WorkspaceError(409, 'This request was already answered or expired.');
      if (approval && approval.status !== 'pending' && approval.status !== 'awaiting_reason')
        throw new WorkspaceError(409, 'This approval is already resolved.');
      const row = approval ?? question;
      const payload = markOperatorResponse({
        questionId: id,
        value,
        userId: ownerId,
        channelType: 'workspace',
        instance: 'workspace',
        platformId: row.platform_id ?? '',
        threadId: row.thread_id ?? null,
      });
      if (approval && !(await isAuthorizedApprovalClick(approval, payload)))
        throw new WorkspaceError(403, 'This approval names a different approver.');
      if (approval?.expires_at && Date.parse(approval.expires_at) <= Date.now())
        throw new WorkspaceError(409, 'This approval expired.');
      if (approval?.status === 'awaiting_reason') {
        if (value.length > 280) throw new WorkspaceError(400, 'Keep the rejection reason under 280 characters.');
        const session = approval.session_id ? await getSession(approval.session_id) : undefined;
        if (!session) throw new WorkspaceError(409, 'The requesting session no longer exists.');
        await finalizeReject(approval, session, ownerId, value);
        return;
      }
      if (approval) {
        const options = JSON.parse(approval.options_json || '[]') as Array<string | { value?: string; label?: string }>;
        if (
          approval.status !== 'awaiting_reason' &&
          !options.some((o) => (typeof o === 'string' ? o === value : (o.value ?? o.label) === value))
        )
          throw new WorkspaceError(400, 'Choose one of the available approval actions.');
      }
      for (const handler of getResponseHandlers()) if (await handler(payload)) return;
      throw new WorkspaceError(409, 'The request could not be resolved.');
    },
    agentUtility: async (agentId, prompt, instructions, signal) => {
      if (!agentId) throw new WorkspaceError(400, 'Choose the agent used for this utility request.');
      const db = getDb();
      const config = await db.get<{ provider: string }>(
        'SELECT provider FROM container_configs WHERE agent_group_id=?',
        agentId,
      );
      if (!config || !['claude', 'opencode'].includes(resolveProviderName(undefined, config.provider)))
        throw new WorkspaceError(
          501,
          'Tool-disabled utilities currently support the installed Claude and OpenCode agent providers.',
        );
      let session = await findSystemSession(agentId, 'system:workspace-utilities');
      if (!session) {
        const stamp = new Date().toISOString();
        session = {
          id: `sess-${randomUUID()}`,
          agent_group_id: agentId,
          messaging_group_id: null,
          thread_id: 'system:workspace-utilities',
          agent_provider: null,
          status: 'active',
          container_status: 'stopped',
          last_active: null,
          created_at: stamp,
        };
        await createSession(session);
        initSessionFolder(agentId, session.id);
      }
      const id = randomUUID();
      await writeSessionMessage(agentId, session.id, {
        id: `utility-${id}`,
        kind: 'system',
        content: JSON.stringify({ type: 'workspace_utility_request', id, prompt, instructions }),
        timestamp: new Date().toISOString(),
      });
      if (!(await requestWake(session, 'cli')))
        throw new WorkspaceError(503, 'Could not start the isolated utility session.');
      while (!signal.aborted) {
        const value = await withExistingMailboxSession(agentId, session.id, (box) =>
          box.getWorkspaceState?.(`ws.utility:${id}`),
        );
        if (value) {
          const result = JSON.parse(value);
          if (result.error) throw new WorkspaceError(502, result.error);
          return String(result.text);
        }
        await delay(500, undefined, { signal });
      }
      throw new WorkspaceError(504, 'The agent utility request timed out.');
    },
  };
}
