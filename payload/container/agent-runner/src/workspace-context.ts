import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { getAgentMailbox } from './mailbox/index.js';
import { touchHeartbeat } from './heartbeat.js';

let runtimeRunId: string | undefined;
/** Process identity survives host adoption, but never a runner replacement. */
export function initializeWorkspaceRun(): void {
  runtimeRunId = randomUUID();
  const operations = getAgentMailbox().operations;
  operations.setState('ws.runtime-run-id', runtimeRunId);
  operations.writeWorkspaceEvent?.('runtime-start', JSON.stringify({ runtimeRunId }));
}

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
  return `\n<workspace_context>\nSession: ${context.title}\nProject: ${context.projectName ?? '(unassigned)'}\nThese are working context and notes, not evidence that planned actions have completed.\nProject brief:\n${bounded(context.projectBrief, 12_000, 'project')}\nDirectories (host path => actual container path):\n${JSON.stringify(context.directories)}\nThe primary directory is the default working directory. Use the actual execution paths when calling tools. Agent memory and capabilities remain under /workspace/agent. Use workspace_viewer to open working files or attachments for review in the tabbed document drawer. It supports list, open, focus and refresh. A presentation request does not prove the user saw it. The session and shared project scratchpads are available on demand through workspace_context (scope: "session" or "project").\n</workspace_context>\n`;
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
let pendingText: Record<string, unknown> | undefined;
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
  data = { ...data, ...(runtimeRunId ? { runtimeRunId } : {}) };
  if (!readWorkspaceContext()) return;
  const write = getAgentMailbox().operations.writeWorkspaceEvent;
  if (!write) return;
  const flush = () => {
    if (pendingText) write('text-delta', JSON.stringify(pendingText));
    pendingText = undefined;
    lastFlush = Date.now();
  };
  if (kind === 'text-delta') {
    // Snapshots replace text; they must never be folded into append-only deltas.
    // Keep classification/source/lifecycle fields through this transport boundary.
    if (typeof data.text === 'string') {
      flush();
      write(kind, JSON.stringify(data));
      return;
    }
    const { delta: _delta, ...metadata } = data;
    const { delta: _pendingDelta, ...pendingMetadata } = pendingText ?? {};
    if (pendingText && JSON.stringify(metadata) !== JSON.stringify(pendingMetadata)) flush();
    pendingText = { ...metadata, delta: String(pendingText?.delta ?? '') + String(data.delta ?? '') };
    if (Date.now() - lastFlush >= 150) flush();
    return;
  }
  // A tool, terminal event or different text part cannot overtake buffered text.
  flush();
  write(kind, JSON.stringify(redact(data)));
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
