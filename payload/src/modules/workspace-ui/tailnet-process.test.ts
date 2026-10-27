import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { it, expect } from 'vitest';

it('releases its owned foreground Serve child when the host process disappears', async () => {
  fs.mkdirSync(path.resolve('.cache'), { recursive: true });
  const root = fs.mkdtempSync(path.resolve('.cache/workspace-tailnet-parent-'));
  const ready = path.join(root, 'ready');
  const stopped = path.join(root, 'stopped');
  const ids = path.join(root, 'ids');
  fs.writeFileSync(
    path.join(root, 'tailscale'),
    `#!/usr/bin/env node\nimport fs from 'node:fs'; process.on('SIGINT',()=>{fs.writeFileSync(process.env.WORKSPACE_TAILNET_TEST_STOPPED,'stopped');process.exit(0)});fs.writeFileSync(process.env.WORKSPACE_TAILNET_TEST_READY, String(process.pid));setInterval(()=>{},1000);\n`,
    { mode: 0o700 },
  );
  const parent = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {fork} from 'node:child_process';import fs from 'node:fs';const child=fork(process.argv[1],['serve'],{execArgv:[],stdio:['ignore','ignore','inherit','ipc']});fs.writeFileSync(process.argv[2],String(child.pid));`,
      path.resolve('src/modules/workspace-ui/tailnet-process.ts'),
      ids,
    ],
    {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        WORKSPACE_TAILNET_TEST_READY: ready,
        WORKSPACE_TAILNET_TEST_STOPPED: stopped,
      },
    },
  );
  let diagnostic = '';
  parent.stderr?.on('data', (data) => (diagnostic += data.toString()));
  const until = async (file: string) => {
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(file)) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${path.basename(file)}: ${diagnostic}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  try {
    await until(ready);
    parent.kill('SIGTERM');
    await until(stopped);
    expect(fs.readFileSync(stopped, 'utf8')).toBe('stopped');
  } finally {
    parent.kill('SIGTERM');
    for (const file of [ids, ready])
      if (fs.existsSync(file)) {
        const pid = Number(fs.readFileSync(file, 'utf8'));
        try {
          process.kill(pid, 'SIGTERM');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 15000);
