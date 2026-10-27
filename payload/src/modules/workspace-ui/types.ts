import type { WorkspaceAppearance } from './appearance.js';
import { DEFAULT_APPEARANCE } from './appearance.js';

export type UtilityTask = 'title' | 'session-summary' | 'project-summary';
export type UtilityProfile =
  | { provider: 'ollama'; model: string; endpoint: string }
  | { provider: 'apple' }
  | { provider: 'agent'; agentId?: string };

export interface WorkspaceSettings extends WorkspaceAppearance {
  enabled: boolean;
  port: number;
  utility: UtilityProfile;
  overrides: Partial<Record<UtilityTask, UtilityProfile>>;
  automaticSummaries: boolean;
  maintenanceAgentId: string | null;
}

export const DEFAULT_SETTINGS: WorkspaceSettings = {
  enabled: false,
  port: 3210,
  ...DEFAULT_APPEARANCE,
  utility: { provider: 'agent' },
  overrides: {},
  automaticSummaries: true,
  maintenanceAgentId: null,
};

export interface DirectoryAttachment {
  id: string;
  path: string;
  readonly: boolean;
}

export interface WorkspaceProject {
  id: string;
  name: string;
  description: string;
  directories: DirectoryAttachment[];
  archived: boolean;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceSession {
  runtimeDriver?: string | null;
  id: string;
  nativeSessionId: string | null;
  agentId: string;
  projectId: string | null;
  title: string;
  customTitle: boolean;
  directories: DirectoryAttachment[];
  primaryDirectoryId: string | null;
  model: string | null;
  effort: string | null;
  pinned: boolean;
  archived: boolean;
  origin: 'native' | 'openclaw';
  sourceKey: string | null;
  continuedFrom: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Scratchpad {
  scope: 'session' | 'project';
  scopeId: string;
  markdown: string;
  revision: number;
  author: string;
  updatedAt: string;
}

export interface WorkspaceMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  kind: string;
  text: string;
  timestamp: string;
  source: string;
  files: Array<{ name: string; id: string; mime?: string }>;
  data?: Record<string, unknown>;
}

export class WorkspaceError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

export function requiredText(value: unknown, name: string, max = 20_000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new WorkspaceError(400, `${name} must contain between 1 and ${max} characters.`);
  }
  return value.trim();
}

export function parseDirectories(value: unknown): DirectoryAttachment[] {
  if (!Array.isArray(value) || value.length > 24) throw new WorkspaceError(400, 'Choose at most 24 directories.');
  const seen = new Set<string>();
  return value.map((raw) => {
    if (!raw || typeof raw !== 'object') throw new WorkspaceError(400, 'Invalid directory.');
    const id = requiredText(raw.id, 'Directory id', 100);
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || seen.has(id)) throw new WorkspaceError(400, 'Directory ids must be unique.');
    seen.add(id);
    const directory = requiredText(raw.path, 'Directory path', 4096);
    if (!directory.startsWith('/') || directory.includes('\0'))
      throw new WorkspaceError(400, 'Use an absolute directory path.');
    if (typeof raw.readonly !== 'boolean') throw new WorkspaceError(400, 'Choose read or write access.');
    return { id, path: directory, readonly: raw.readonly };
  });
}

export function parseProfile(value: unknown): UtilityProfile {
  if (!value || typeof value !== 'object') throw new WorkspaceError(400, 'Choose a utility provider.');
  const p = value as Record<string, unknown>;
  if (p.provider === 'apple') return { provider: 'apple' };
  if (p.provider === 'agent')
    return { provider: 'agent', ...(p.agentId ? { agentId: requiredText(p.agentId, 'Agent', 200) } : {}) };
  if (p.provider === 'ollama') {
    const endpoint = new URL(requiredText(p.endpoint, 'Ollama endpoint', 2048));
    if (
      !['http:', 'https:'].includes(endpoint.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      endpoint.pathname !== '/'
    ) {
      throw new WorkspaceError(400, 'Ollama must use a local HTTP endpoint without credentials or a path.');
    }
    return { provider: 'ollama', endpoint: endpoint.origin, model: requiredText(p.model, 'Ollama model', 200) };
  }
  throw new WorkspaceError(400, 'Unknown utility provider.');
}
