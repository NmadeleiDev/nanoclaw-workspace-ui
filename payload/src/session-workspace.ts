import type { ContainerConfig } from './container-config.js';
import type { Session } from './types.js';

/** The optional workspace add-on supplies session-specific runtime configuration. */
let configuration: ((session: Session, base: ContainerConfig) => Promise<ContainerConfig>) | undefined;
let context: ((sessionId: string) => Promise<string | undefined>) | undefined;

export function registerSessionWorkspace(hooks: {
  configure: NonNullable<typeof configuration>;
  context: NonNullable<typeof context>;
}): void {
  configuration = hooks.configure;
  context = hooks.context;
}

export function sessionWorkspaceConfiguration(session: Session, base: ContainerConfig): Promise<ContainerConfig> {
  return configuration ? configuration(session, base) : Promise.resolve(base);
}

export function sessionWorkspaceContext(sessionId: string): Promise<string | undefined> {
  return context ? context(sessionId) : Promise.resolve(undefined);
}
