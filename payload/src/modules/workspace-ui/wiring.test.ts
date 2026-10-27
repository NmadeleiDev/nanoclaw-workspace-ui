import fs from 'node:fs';
import { it, expect } from 'vitest';

// These checks guard import-time integration edges that isolated store tests cannot exercise.
it('connects the workspace to real lifecycle, routing, per-session configuration and two-way mailboxes', () => {
  const read = (file: string) => fs.readFileSync(file, 'utf8');
  expect(read('src/modules/index.ts')).toContain("import './workspace-ui/index.js'");
  expect(read('src/container-runner.ts')).toContain(
    'await sessionWorkspaceConfiguration(session, await materializeContainerJson(agentGroup.id))',
  );
  expect(read('src/session-manager.ts')).toContain('await sessionWorkspaceContext(sessionId)');
  expect(read('src/modules/workspace-ui/bridge.ts')).toContain('return routeOperatorMessage(');
  expect(read('src/modules/workspace-ui/index.ts')).toContain('onHostStart(');
  expect(read('src/modules/workspace-ui/index.ts')).toContain('registerDeliveryBatchPreview(');
  expect(read('src/mailbox/sqlite/index.ts')).toContain('setWorkspaceContext:');
  expect(read('container/agent-runner/src/poll-loop.ts')).toContain('prompt + renderWorkspaceContext()');
  expect(read('container/agent-runner/src/poll-loop.ts')).toContain('emitWorkspaceEvent(event.kind');
  expect(read('container/agent-runner/src/mcp-tools/index.ts')).toContain("'./workspace.js'");
});
it('keeps utility providers tool-free in the installed and replayed provider configuration', () => {
  const installed = 'container/agent-runner/src/providers/opencode-config.ts';
  if (fs.existsSync(installed)) {
    const config = fs.readFileSync(installed, 'utf8');
    expect(config).toMatch(/options\.utilityMode\s*\?\s*\{\s*'\*':\s*'deny'\s*\}/);
    expect(config).toMatch(/options\.utilityMode\s*\?\s*\{\}/);
    expect(config).toMatch(/options\.utilityMode\s*\?\s*\[\]/);
  }
  const claude = fs.readFileSync('container/agent-runner/src/providers/claude.ts', 'utf8');
  expect(claude).toContain('tools: []');
  expect(claude).toContain('settingSources: input.utility ? []');
  expect(claude).toMatch(/hooks:\s*input\.utility\s*\?\s*\{\}/);
});
