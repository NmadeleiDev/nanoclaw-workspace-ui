import { parseSpeech } from './speech.js';
import { randomUUID } from 'node:crypto';
import type { DbDriver } from '../../db/driver.js';
import { APPEARANCE_MODES, THEME_PRESETS } from './appearance.js';
import {
  DEFAULT_SETTINGS,
  WorkspaceError,
  parseDirectories,
  parseProfile,
  requiredText,
  type WorkspaceProject,
  type WorkspaceSession,
  type WorkspaceSettings,
  type Scratchpad,
  type WorkspaceMessage,
} from './types.js';

type Row = Record<string, any>;
const now = () => new Date().toISOString();
const project = (r: Row): WorkspaceProject => ({
  id: r.id,
  name: r.name,
  description: r.description,
  directories: JSON.parse(r.directories),
  archived: !!r.archived,
  position: r.position,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const session = (r: Row): WorkspaceSession => ({
  id: r.id,
  runtimeDriver: 'docker',
  nativeSessionId: r.native_session_id,
  agentId: r.agent_id,
  projectId: r.project_id,
  title: r.title,
  customTitle: !!r.custom_title,
  directories: JSON.parse(r.directories),
  primaryDirectoryId: r.primary_directory_id,
  model: r.model,
  effort: r.effort,
  pinned: !!r.pinned,
  archived: !!r.archived,
  origin: r.origin,
  sourceKey: r.source_key,
  continuedFrom: r.continued_from,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const scratchpad = (r: Row): Scratchpad => ({
  scope: r.scope,
  scopeId: r.scope_id,
  markdown: r.markdown,
  revision: r.revision,
  author: r.author,
  updatedAt: r.updated_at,
});

export class WorkspaceStore {
  constructor(readonly db: DbDriver) {}

  async settings(): Promise<WorkspaceSettings> {
    const row = await this.db.get<{ value: string }>('SELECT value FROM ws_settings WHERE id = ?', 'workspace');
    return row ? { ...structuredClone(DEFAULT_SETTINGS), ...JSON.parse(row.value) } : structuredClone(DEFAULT_SETTINGS);
  }

  async saveSettings(input: Partial<WorkspaceSettings>): Promise<WorkspaceSettings> {
    const old = await this.settings();
    const value = { ...old, ...input };
    if (!Number.isInteger(value.port) || value.port < 1024 || value.port > 65535)
      throw new WorkspaceError(400, 'Port must be between 1024 and 65535.');
    if (!Number.isInteger(value.textScale) || value.textScale < 100 || value.textScale > 200)
      throw new WorkspaceError(400, 'Text size must be between 100% and 200%.');
    if (!APPEARANCE_MODES.includes(value.theme)) throw new WorkspaceError(400, 'Unknown theme.');
    if (!THEME_PRESETS.includes(value.themePreset)) throw new WorkspaceError(400, 'Unknown theme preset.');
    if (typeof value.ambientMotion !== 'boolean') throw new WorkspaceError(400, 'Invalid ambient motion setting.');
    if (typeof value.enabled !== 'boolean' || typeof value.automaticSummaries !== 'boolean')
      throw new WorkspaceError(400, 'Invalid settings.');
    value.speech = parseSpeech(value.speech);
    value.utility = parseProfile(value.utility);
    value.overrides = Object.fromEntries(
      Object.entries(value.overrides).map(([key, profile]) => {
        if (!['title', 'session-summary', 'project-summary'].includes(key))
          throw new WorkspaceError(400, 'Unknown utility task.');
        return [key, parseProfile(profile)];
      }),
    );
    if (
      value.maintenanceAgentId &&
      !(await this.db.get('SELECT id FROM agent_groups WHERE id = ?', value.maintenanceAgentId))
    )
      throw new WorkspaceError(400, 'Maintenance agent not found.');
    await this.db.run(
      'INSERT INTO ws_settings (id, value) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET value = excluded.value',
      'workspace',
      JSON.stringify(value),
    );
    return value;
  }

  async projects(): Promise<WorkspaceProject[]> {
    return (await this.db.all<Row>('SELECT * FROM ws_projects ORDER BY position, created_at')).map(project);
  }

  async getProject(id: string): Promise<WorkspaceProject> {
    const row = await this.db.get<Row>('SELECT * FROM ws_projects WHERE id = ?', id);
    if (!row) throw new WorkspaceError(404, 'Project not found.');
    return project(row);
  }

  async saveProject(input: Partial<WorkspaceProject> & { name: string }): Promise<WorkspaceProject> {
    const previous = input.id ? await this.getProject(input.id) : undefined;
    const id = previous?.id ?? randomUUID();
    const name = requiredText(input.name, 'Project name', 150);
    const description = input.description ?? previous?.description ?? '';
    if (typeof description !== 'string' || description.length > 40_000)
      throw new WorkspaceError(400, 'Project brief is too long.');
    const directories = parseDirectories(input.directories ?? previous?.directories ?? []);
    const position = input.position ?? previous?.position ?? (await this.projects()).length;
    if (!Number.isInteger(position) || position < 0) throw new WorkspaceError(400, 'Invalid project position.');
    const stamp = now();
    await this.db.run(
      `INSERT INTO ws_projects (id,name,description,directories,archived,position,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description,
      directories=excluded.directories,archived=excluded.archived,position=excluded.position,updated_at=excluded.updated_at`,
      id,
      name,
      description,
      JSON.stringify(directories),
      (input.archived ?? previous?.archived ?? false) ? 1 : 0,
      position,
      previous?.createdAt ?? stamp,
      stamp,
    );
    return this.getProject(id);
  }

  async sessions(): Promise<WorkspaceSession[]> {
    return (await this.db.all<Row>('SELECT w.* FROM ws_sessions w LEFT JOIN sessions n ON n.id=w.native_session_id ORDER BY w.pinned DESC,w.updated_at DESC')).map(session);
  }

  async getSession(id: string): Promise<WorkspaceSession> {
    const row = await this.db.get<Row>('SELECT w.* FROM ws_sessions w LEFT JOIN sessions n ON n.id=w.native_session_id WHERE w.id = ?', id);
    if (!row) throw new WorkspaceError(404, 'Session not found.');
    return session(row);
  }

  async addSession(
    input: Pick<WorkspaceSession, 'id' | 'agentId'> & Partial<WorkspaceSession>,
  ): Promise<WorkspaceSession> {
    if (!(await this.db.get('SELECT id FROM agent_groups WHERE id = ?', input.agentId)))
      throw new WorkspaceError(404, 'Agent not found.');
    const p = input.projectId ? await this.getProject(input.projectId) : undefined;
    const directories = parseDirectories(input.directories ?? p?.directories ?? []);
    const primary = input.primaryDirectoryId ?? directories[0]?.id ?? null;
    if (primary && !directories.some((d) => d.id === primary))
      throw new WorkspaceError(400, 'Working directory must be attached.');
    const stamp = input.createdAt ?? now();
    await this.db.run(
      `INSERT INTO ws_sessions (id,native_session_id,agent_id,project_id,title,custom_title,directories,
      primary_directory_id,model,effort,pinned,archived,origin,source_key,continued_from,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
      input.id,
      input.nativeSessionId ?? null,
      input.agentId,
      p?.id ?? null,
      input.title ?? 'New conversation',
      input.customTitle ? 1 : 0,
      JSON.stringify(directories),
      primary,
      input.model ?? null,
      input.effort ?? null,
      input.pinned ? 1 : 0,
      input.archived ? 1 : 0,
      input.origin ?? 'native',
      input.sourceKey ?? null,
      input.continuedFrom ?? null,
      stamp,
      input.updatedAt ?? stamp,
    );
    return this.getSession(input.id);
  }

  async updateSession(id: string, input: Partial<WorkspaceSession>, generated = false): Promise<WorkspaceSession> {
    const old = await this.getSession(id);
    if (generated) {
      if (input.title !== undefined)
        await this.db.run(
          'UPDATE ws_sessions SET title=?,updated_at=? WHERE id=? AND custom_title=0',
          requiredText(input.title, 'Session title', 200),
          now(),
          id,
        );
      return this.getSession(id);
    }
    const projectId = input.projectId === undefined ? old.projectId : input.projectId;
    if (projectId) await this.getProject(projectId);
    const directories = parseDirectories(input.directories ?? old.directories);
    const primary = input.primaryDirectoryId === undefined ? old.primaryDirectoryId : input.primaryDirectoryId;
    if (primary && !directories.some((d) => d.id === primary))
      throw new WorkspaceError(400, 'Choose an attached working directory.');
    const title =
      input.title === undefined || (generated && old.customTitle)
        ? old.title
        : requiredText(input.title, 'Session title', 200);
    for (const key of ['model', 'effort'] as const) {
      if (input[key] != null) requiredText(input[key], key, 200);
    }
    await this.db.run(
      `UPDATE ws_sessions SET project_id=?,title=?,custom_title=?,directories=?,primary_directory_id=?,
      model=?,effort=?,pinned=?,archived=?,updated_at=? WHERE id=?`,
      projectId,
      title,
      old.customTitle || (input.title !== undefined && !generated) ? 1 : 0,
      JSON.stringify(directories),
      primary,
      input.model === undefined ? old.model : input.model,
      input.effort === undefined ? old.effort : input.effort,
      (input.pinned ?? old.pinned) ? 1 : 0,
      (input.archived ?? old.archived) ? 1 : 0,
      now(),
      id,
    );
    return this.getSession(id);
  }

  async document(scope: Scratchpad['scope'], scopeId: string): Promise<Scratchpad> {
    if (scope === 'project') await this.getProject(scopeId);
    else await this.getSession(scopeId);
    const row = await this.db.get<Row>('SELECT * FROM ws_scratchpads WHERE scope=? AND scope_id=?', scope, scopeId);
    return row ? scratchpad(row) : { scope, scopeId, revision: 0, markdown: '', author: '', updatedAt: '' };
  }

  async saveDocument(
    scope: Scratchpad['scope'],
    scopeId: string,
    markdown: string,
    revision: number,
    author: string,
  ): Promise<Scratchpad> {
    if (typeof markdown !== 'string' || markdown.length > 100_000 || !Number.isInteger(revision) || revision < 0)
      throw new WorkspaceError(400, 'Invalid scratchpad.');
    await this.db.transaction(async () => {
      const current = await this.document(scope, scopeId);
      if (current.revision !== revision)
        throw new WorkspaceError(409, 'This scratchpad changed. Review the latest version before saving.');
      const stamp = now();
      const changed =
        revision === 0
          ? await this.db.run(
              `INSERT INTO ws_scratchpads (scope,scope_id,revision,markdown,author,updated_at) VALUES (?,?,1,?,?,?) ON CONFLICT(scope,scope_id) DO NOTHING`,
              scope,
              scopeId,
              markdown,
              author,
              stamp,
            )
          : await this.db.run(
              'UPDATE ws_scratchpads SET revision=?,markdown=?,author=?,updated_at=? WHERE scope=? AND scope_id=? AND revision=?',
              revision + 1,
              markdown,
              author,
              stamp,
              scope,
              scopeId,
              revision,
            );
      if (!changed.changes) throw new WorkspaceError(409, 'The scratchpad was edited during this update.');
      await this.db.run(
        'INSERT INTO ws_revisions (scope,scope_id,revision,markdown,author,updated_at) VALUES (?,?,?,?,?,?)',
        scope,
        scopeId,
        revision + 1,
        markdown,
        author,
        stamp,
      );
    });
    return this.document(scope, scopeId);
  }

  async revisions(scope: Scratchpad['scope'], id: string): Promise<Scratchpad[]> {
    await this.document(scope, id);
    return (
      await this.db.all<Row>(
        'SELECT * FROM ws_revisions WHERE scope=? AND scope_id=? ORDER BY revision DESC LIMIT 100',
        scope,
        id,
      )
    ).map(scratchpad);
  }

  async putMessage(message: WorkspaceMessage): Promise<boolean> {
    const result = await this.db.run(
      `INSERT INTO ws_messages (id,session_id,role,kind,text,timestamp,source,files,data)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
      message.id,
      message.sessionId,
      message.role,
      message.kind,
      message.text,
      message.timestamp,
      message.source,
      JSON.stringify(message.files),
      JSON.stringify(message.data ?? {}),
    );
    if (result.changes)
      await this.db.run(
        'UPDATE ws_sessions SET updated_at = CASE WHEN updated_at < ? THEN ? ELSE updated_at END WHERE id=?',
        message.timestamp,
        message.timestamp,
        message.sessionId,
      );
    return result.changes > 0;
  }

  async history(
    id: string,
    before?: string,
    limit = 100,
  ): Promise<{ messages: WorkspaceMessage[]; next: string | null }> {
    await this.getSession(id);
    const n = Math.max(1, Math.min(250, limit));
    const rows = await this.db.all<Row>(
      `SELECT * FROM ws_messages WHERE session_id=? ${before ? "AND (timestamp || '|' || id) < ?" : ''} ORDER BY timestamp DESC,id DESC LIMIT ?`,
      id,
      ...(before ? [before] : []),
      n + 1,
    );
    const more = rows.length > n;
    const page = rows.slice(0, n).reverse();
    return {
      messages: page.map((r) => ({
        id: r.id,
        sessionId: r.session_id,
        role: r.role,
        kind: r.kind,
        text: r.text,
        timestamp: r.timestamp,
        source: r.source,
        files: JSON.parse(r.files),
        data: JSON.parse(r.data),
      })),
      next: more && page[0] ? `${page[0].timestamp}|${page[0].id}` : null,
    };
  }

  async search(query: string, agentId?: string): Promise<unknown[]> {
    const escaped = requiredText(query, 'Search', 200).replace(/[\\%_]/g, '\\$&');
    return this.db.all(
      `SELECT m.id,m.session_id,s.title,s.agent_id,s.project_id,m.role,m.timestamp,
      SUBSTR(m.text,1,500) AS excerpt FROM ws_messages m JOIN ws_sessions s ON s.id=m.session_id
      WHERE (LOWER(m.text) LIKE LOWER(?) ESCAPE '\\' OR LOWER(s.title) LIKE LOWER(?) ESCAPE '\\')
      ${agentId ? 'AND s.agent_id=?' : ''} ORDER BY m.timestamp DESC LIMIT 80`,
      `%${escaped}%`,
      `%${escaped}%`,
      ...(agentId ? [agentId] : []),
    );
  }
}
