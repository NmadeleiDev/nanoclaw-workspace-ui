/** Own one foreground Serve lease, including when the host exits unexpectedly. */
import { spawn } from 'node:child_process';

const child = spawn('tailscale', process.argv.slice(2), {
  detached: process.platform !== 'win32',
  stdio: ['ignore', 'inherit', 'inherit'],
});
let stopping = false;
let timer: ReturnType<typeof setTimeout> | undefined;
const stop = () => {
  if (stopping) return;
  stopping = true;
  const signal = (value: NodeJS.Signals) => {
    try {
      if (process.platform === 'win32') child.kill(value);
      else if (child.pid) process.kill(-child.pid, value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  signal('SIGINT');
  timer = setTimeout(() => signal('SIGKILL'), 6000);
};
process.on('disconnect', stop);
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.once('error', (error) => {
  console.error(error.message);
  process.exit(1);
});
child.once('exit', (code) => {
  if (timer) clearTimeout(timer);
  process.exit(code ?? 0);
});
if (!process.connected) stop();
