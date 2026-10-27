import fs from 'node:fs';
import { getAgentMailbox } from './mailbox/index.js';
import type { AgentProvider } from './providers/types.js';

/** Utility sessions never run chat formatting, tools, memory hooks, or chat delivery. */
export async function runWorkspaceUtilities(provider: AgentProvider, signal?: AbortSignal): Promise<void> {
  const operations = getAgentMailbox().operations;
  const cwd = '/workspace/utility';
  fs.mkdirSync(cwd, { recursive: true });
  while (!signal?.aborted) {
    for (const message of operations.getPendingMessages(8, true)) {
      if (message.kind !== 'system') {
        operations.markMessages([message.id], 'completed');
        continue;
      }
      const request = JSON.parse(message.content);
      if (request.type !== 'workspace_utility_request') continue;
      operations.markMessages([message.id], 'processing');
      try {
        const query = provider.query({
          utility: true,
          prompt: String(request.prompt),
          cwd,
          systemContext: { instructions: String(request.instructions) },
        });
        query.end();
        const timeout = setTimeout(() => query.abort(), 240_000);
        const abort = () => query.abort();
        signal?.addEventListener('abort', abort, { once: true });
        let text: string | null = null;
        try {
          for await (const event of query.events) {
            if (event.type === 'result') {
              if (event.isError) throw new Error(event.error ?? 'Agent utility inference failed.');
              text = event.text;
            } else if (event.type === 'error') throw new Error(event.message);
          }
        } finally {
          clearTimeout(timeout);
          signal?.removeEventListener('abort', abort);
        }
        if (!text?.trim()) throw new Error('The agent model returned no utility result.');
        operations.setState(`ws.utility:${request.id}`, JSON.stringify({ text: text.trim() }));
      } catch (error) {
        operations.setState(
          `ws.utility:${request.id}`,
          JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
        );
      }
      operations.markMessages([message.id], 'completed');
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
