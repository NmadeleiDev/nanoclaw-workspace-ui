import fs from 'node:fs';
import { getAgentMailbox } from './mailbox/index.js';
import { touchHeartbeat } from './heartbeat.js';

/** These records are supplied by the host, rather than shared group documents. */
export function readWorkspaceContext(): Record<string, any> | null {
  const raw = getAgentMailbox().operations.workspaceContext?.();
  if (!raw) return null;
  return JSON.parse(raw.value);
}

export function renderWorkspaceContext(): string {
  const context = readWorkspaceContext();
  if (!context) return '';
  const bounded = (text: unknown, budget: number, location: string) => {
    if (typeof text !== 'string') return '';
    return text.length > budget
      ? `${text.slice(0, budget)}\n[Excerpt. Read the full document with workspace_context: ${location}]`
      : text;
  };
  return `\n<workspace_context>\nSession: ${context.title}\nProject: ${context.projectName ?? '(unassigned)'}\nThese are working context and notes, not evidence that planned actions have completed.\nProject brief:\n${bounded(context.projectBrief, 12_000, 'project')}\nSession scratchpad (revision ${context.scratchpadRevision}):\n${bounded(context.scratchpad, 12_000, 'session')}\nDirectories (host path => actual container path):\n${JSON.stringify(context.directories)}\nThe primary directory is the default working directory. Use the actual execution paths when calling tools. Agent memory and capabilities remain under /workspace/agent. The shared project scratchpad is available on demand through workspace_context.\n</workspace_context>\n`;
}

export function agentInstructionsForWorkingDirectory(cwd: string): string {
  if (cwd === '/workspace/agent') return '';
  // Changing cwd must not drop the agent's composed standing instructions.
  for (const file of [`/workspace/agent/CLAUDE.md`, `/workspace/agent/AGENTS.md`]) {
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  }
  throw new Error('The composed agent instructions are missing for this working directory.');
}

let lastFlush = 0;
const deltas = new Map<string, string>();
function redact(value: unknown, key = '', depth = 0): unknown {
  if (/secret|password|authorization|api[_-]?key|access[_-]?token|refresh[_-]?token/i.test(key)) return '[redacted]';
  if (typeof value === 'string')
    return value.length > 16_000 ? `${value.slice(0, 16_000)}\n[display truncated]` : value;
  if (depth > 8) return '[nested data]';
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redact(item, '', depth + 1));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 100)
        .map(([k, v]) => [k, redact(v, k, depth + 1)]),
    );
  return value;
}

export function emitWorkspaceEvent(kind: string, data: Record<string, unknown>): void {
  if (!readWorkspaceContext()) return;
  const write = getAgentMailbox().operations.writeWorkspaceEvent;
  if (!write) return;
  if (kind === 'text-delta') {
    const id = String(data.id);
    deltas.set(id, (deltas.get(id) ?? '') + String(data.delta ?? ''));
    if (Date.now() - lastFlush < 150) return;
  }
  for (const [id, delta] of deltas) write('text-delta', JSON.stringify({ id, delta }));
  deltas.clear();
  lastFlush = Date.now();
  if (kind !== 'text-delta') write(kind, JSON.stringify(redact(data)));
}

export function acknowledgeWorkspaceReconfigure(): boolean {
  const raw = getAgentMailbox().operations.workspaceContext?.()?.control;
  const control = raw ? JSON.parse(raw) : null;
  if (control?.kind !== 'reconfigure') return false;
  getAgentMailbox().operations.setState('ws.reconfigure-ready', String(control.id));
  return true;
}

/** Freeze before claiming another turn; the host can now replace this idle incarnation safely. */
export async function holdWorkspaceReconfigure(signal?: AbortSignal): Promise<void> {
  while (!signal?.aborted && acknowledgeWorkspaceReconfigure()) {
    touchHeartbeat();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
