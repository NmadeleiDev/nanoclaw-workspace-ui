import { getAgentMailbox } from './mailbox/index.js';

export function approvalWait() {
  return getAgentMailbox().operations.getState('approval_wait')?.value;
}

/** Old hosts cannot resolve a durable wait. Negotiate before blocking a tool. */
export function supportsApprovalWait() {
  const value = getAgentMailbox().operations.workspaceContext?.()?.value;
  return value ? JSON.parse(value).approvalProtocol === 1 : false;
}

export function beginApprovalWait(correlationId: string, at = new Date().toISOString()) {
  const box = getAgentMailbox().operations;
  if (!box.checkpointApprovalWait) throw new Error('Mailbox cannot checkpoint an approval wait');
  box.checkpointApprovalWait(correlationId, at);
}

export function clearApprovalWait() {
  getAgentMailbox().operations.deleteState('approval_wait');
}

export function checkApprovalWait() {
  const box = getAgentMailbox().operations;
  const control = box.workspaceContext?.()?.control;
  const command = control ? JSON.parse(control) : null;
  let saved = box.getState('approval_wait');
  // The host can also suspend a runner which loaded before the protocol upgrade.
  if (!saved && command?.kind === 'approval_wait') {
    beginApprovalWait(command.requestId, command.at);
    saved = box.getState('approval_wait');
  }
  if (!saved) return false;
  const wait = JSON.parse(saved.value);
  if (
    command &&
    (command.kind === 'approval_resolved' || (command.kind === 'cancel' && command.approvalCancelled === true)) &&
    Date.parse(command.at) >= Date.parse(wait.at)
  ) {
    const ids = box.getState('approval_wait_ids');
    if (ids) {
      box.markMessages(JSON.parse(ids.value), 'completed');
      box.deleteState('approval_wait_ids');
    }
    clearApprovalWait();
    return false;
  }
  return true;
}
