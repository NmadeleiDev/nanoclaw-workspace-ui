import { randomUUID } from 'node:crypto';
import { getAgentMailbox } from '../mailbox/index.js';
import { writeMessageOut } from '../db/messages-out.js';
import { readWorkspaceContext } from '../workspace-context.js';
import { registerTools } from './server.js';

async function workspaceRequest(action: string, args: Record<string, unknown>, context?: { signal: AbortSignal }): Promise<import('@modelcontextprotocol/sdk/types.js').CallToolResult> {
  const id = randomUUID();
  await writeMessageOut({
    id: `workspace-request-${id}`,
    kind: 'system',
    content: JSON.stringify({
      action,
      operation: args.operation,
      path: args.path,
      attachmentId: args.attachmentId,
      documentId: args.documentId,
      requestId: id,
      scope: args.scope,
      markdown: args.markdown,
      revision: args.revision,
      before: args.before,
    }),
  });
  const mailbox = getAgentMailbox().operations;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !context?.signal.aborted) {
    const response = mailbox.getMessageIn(`workspace-response-${id}`);
    if (response) {
      mailbox.markMessages([response.id], 'completed');
      const result = JSON.parse(response.content);
      return {
        isError: !!result.error,
        content: [{ type: 'text', text: JSON.stringify(result.error ? { error: result.error } : result.data) }],
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return {
    isError: true,
    content: [{ type: 'text', text: 'Workspace request timed out. No update is confirmed.' }],
  };
}

const tools: import('./types.js').McpToolDefinition[] = [
  {
    tool: {
      name: 'workspace_context',
      description:
        'Read the current session or shared project scratchpad, update it using its revision, or page through the reference conversation this session continues. Scratchpads are working notes, not verified execution receipts.',
      inputSchema: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['session', 'project', 'reference-history'] },
          markdown: { type: 'string', description: 'Optional complete updated scratchpad. Omit to read.' },
          revision: { type: 'integer', description: 'Required current document revision when updating.' },
          before: { type: 'string', description: 'Pagination cursor for reference history.' },
        },
        required: ['scope'],
      },
    },
    async handler(args, context) {
      const workspace = readWorkspaceContext();
      if (!workspace)
        return { isError: true, content: [{ type: 'text', text: 'This session has no workspace project context.' }] };
      if (args.markdown === undefined && args.scope !== 'reference-history') {
        const project = args.scope === 'project';
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                scope: args.scope,
                markdown: project ? workspace.projectScratchpad : workspace.scratchpad,
                revision: project ? workspace.projectScratchpadRevision : workspace.scratchpadRevision,
                projectBrief: project ? workspace.projectBrief : undefined,
                directories: workspace.directories,
              }),
            },
          ],
        };
      }
      return workspaceRequest('workspace_context', args, context);
    },
  },
];

export const workspaceViewer: import('./types.js').McpToolDefinition = {
  tool: {
    name: 'workspace_viewer',
    description:
      'Open a working document or attachment in the user’s tabbed workspace drawer, focus or refresh it, or list registered documents. This requests presentation; it does not confirm the user saw it. Never print the document in chat.',
    inputSchema: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['list', 'open', 'focus', 'refresh'] },
        path: { type: 'string' },
        attachmentId: { type: 'string' },
        documentId: { type: 'string' },
      },
      required: ['operation'],
    },
  },
  async handler(args, context) {
    // Use the same correlated mailbox exchange as workspace_context.
    if (!readWorkspaceContext())
      return { isError: true, content: [{ type: 'text', text: 'This session has no workspace context.' }] };
    return workspaceRequest('workspace_viewer', args, context);
  },
};
registerTools([...tools, workspaceViewer]);
