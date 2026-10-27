import { randomUUID } from 'node:crypto';
import { getAgentMailbox } from '../mailbox/index.js';
import { writeMessageOut } from '../db/messages-out.js';
import { readWorkspaceContext } from '../workspace-context.js';
import { registerTools } from './server.js';

registerTools([
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
      const id = randomUUID();
      await writeMessageOut({
        id: `workspace-request-${id}`,
        kind: 'system',
        content: JSON.stringify({
          action: 'workspace_context',
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
        content: [{ type: 'text', text: 'Workspace context request timed out. No update is confirmed.' }],
      };
    },
  },
]);
