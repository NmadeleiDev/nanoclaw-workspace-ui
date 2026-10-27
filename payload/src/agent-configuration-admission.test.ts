import { it, expect, vi } from 'vitest';
vi.mock('./db/sessions.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./db/sessions.js')>()),
  getSession: vi.fn(async () => undefined),
}));
import { getSession } from './db/sessions.js';
import { beginAgentConfiguration, wakeContainer } from './container-runner.js';
import type { Session } from './types.js';
it('queues a wake until configuration is released and re-reads its current session once', async () => {
  const pause = beginAgentConfiguration('configuration-fixture');
  expect(pause).toBeDefined();
  try {
    expect(beginAgentConfiguration('configuration-fixture')).toBeUndefined();
    await pause!.settle([]);
    expect(await wakeContainer({ id: 'deferred-session', agent_group_id: 'configuration-fixture' } as Session)).toBe(
      false,
    );
    expect(getSession).not.toHaveBeenCalled();
    pause!.release();
    await Promise.resolve();
    expect(getSession).toHaveBeenCalledExactlyOnceWith('deferred-session');
    pause!.release();
    expect(getSession).toHaveBeenCalledTimes(1);
    const next = beginAgentConfiguration('configuration-fixture');
    expect(next).toBeDefined();
    next!.release();
  } finally {
    pause!.release();
  }
});
