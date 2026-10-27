import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import * as zlib from 'node:zlib';
import Database from 'better-sqlite3';
import { WorkspaceError, type WorkspaceSession, type WorkspaceMessage } from './types.js';
import { WorkspaceStore } from './store.js';

type Row = Record<string, any>;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const iso = (value: unknown) => {
  const date = new Date(typeof value === 'number' ? value : String(value));
  if (!Number.isFinite(date.getTime())) throw new WorkspaceError(422, 'OpenClaw contained an invalid timestamp.');
  return date.toISOString();
};

function openReadonly(file: string): Database.Database {
  if (!fs.existsSync(file)) throw new WorkspaceError(404, `OpenClaw source not found: ${file}`);
  const db = new Database(file, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');
  return db;
}

function sourceRoot(root: string): string {
  const real = fs.realpathSync(root.startsWith('~/') ? path.join(os.homedir(), root.slice(2)) : root);
  if (!fs.existsSync(path.join(real, 'state', 'openclaw.sqlite')))
    throw new WorkspaceError(400, 'Choose an OpenClaw state directory.');
  return real;
}

export interface ImportSelection {
  sourceAgentId: string;
  targetAgentId: string;
}
export interface ImportProgress {
  state: 'idle' | 'running' | 'completed' | 'failed';
  sessions: number;
  messages: number;
  files: number;
  unavailableFiles: number;
  warnings: string[];
  error?: string;
}

export class OpenClawImporter {
  progress: ImportProgress = { state: 'idle', sessions: 0, messages: 0, files: 0, unavailableFiles: 0, warnings: [] };
  private runPromise?: Promise<void>;
  private aborted = false;
  constructor(
    readonly store: WorkspaceStore,
    readonly filesRoot: string,
    readonly changed: () => void,
  ) {}

  preview(root = path.join(os.homedir(), '.openclaw')) {
    root = sourceRoot(root);
    const db = openReadonly(path.join(root, 'state', 'openclaw.sqlite'));
    try {
      const groups = db.prepare('SELECT name,position,cwd,worktree FROM session_groups ORDER BY position').all();
      const agents: Row[] = [];
      for (const name of fs.readdirSync(path.join(root, 'agents'))) {
        const file = path.join(root, 'agents', name, 'agent', 'openclaw-agent.sqlite');
        if (!fs.existsSync(file)) continue;
        const agent = openReadonly(file);
        try {
          const stats = agent.prepare('SELECT COUNT(*) AS sessions FROM session_nodes').get() as Row;
          const transcript = agent
            .prepare('SELECT COUNT(*) AS events, SUM(event_zstd IS NOT NULL) AS compressed FROM transcript_events')
            .get() as Row;
          if (stats.sessions) agents.push({ id: name, ...stats, ...transcript });
        } finally {
          agent.close();
        }
      }
      return { root, groups, agents, progress: this.progress };
    } finally {
      db.close();
    }
  }

  start(root: string, selections: ImportSelection[]): ImportProgress {
    if (this.progress.state === 'running') throw new WorkspaceError(409, 'An import is already running.');
    root = sourceRoot(root);
    if (
      !Array.isArray(selections) ||
      !selections.length ||
      selections.length > 30 ||
      selections.some((s) => !s || typeof s.targetAgentId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(s.sourceAgentId)) ||
      new Set(selections.map((s) => s.sourceAgentId)).size !== selections.length
    )
      throw new WorkspaceError(400, 'Choose the agents to import.');
    this.aborted = false;
    this.progress = { state: 'running', sessions: 0, messages: 0, files: 0, unavailableFiles: 0, warnings: [] };
    this.runPromise = this.run(root, selections)
      .then(
        () => {
          this.progress.state = 'completed';
        },
        (error) => {
          this.progress.state = 'failed';
          this.progress.error = error instanceof Error ? error.message : String(error);
        },
      )
      .finally(this.changed);
    return this.progress;
  }

  async stop(): Promise<void> {
    this.aborted = true;
    await this.runPromise;
  }
  private warning(message: string) {
    if (this.progress.warnings.length < 100 && !this.progress.warnings.includes(message))
      this.progress.warnings.push(message);
  }

  private async run(root: string, selections: ImportSelection[]) {
    for (const selection of selections)
      if (!(await this.store.db.get('SELECT id FROM agent_groups WHERE id=?', selection.targetAgentId)))
        throw new WorkspaceError(400, `Target agent not found: ${selection.targetAgentId}`);
    const source = openReadonly(path.join(root, 'state', 'openclaw.sqlite'));
    const projectIds = new Map<string, string>();
    try {
      const groups = source.prepare('SELECT name,cwd,position FROM session_groups ORDER BY position').all() as Row[];
      for (const group of groups) {
        const key = `openclaw:${hash(root)}:group:${group.name}`;
        const previous = await this.store.db.get<{ target_id: string }>(
          'SELECT target_id FROM ws_imports WHERE source_key=?',
          key,
        );
        let id = previous?.target_id;
        if (!id) {
          const existing = (await this.store.projects()).find((p) => p.name === group.name);
          id =
            existing?.id ??
            (
              await this.store.saveProject({
                name: group.name,
                description: '',
                directories: group.cwd ? [{ id: hash(group.cwd).slice(0, 12), path: group.cwd, readonly: false }] : [],
                position: group.position,
              })
            ).id;
          await this.store.db.run(
            'INSERT INTO ws_imports (source_key,target_id,imported_at) VALUES (?,?,?) ON CONFLICT(source_key) DO NOTHING',
            key,
            id,
            new Date().toISOString(),
          );
        }
        projectIds.set(group.name, id);
      }
    } finally {
      source.close();
    }

    for (const selection of selections) {
      if (this.aborted) throw new Error('Import paused during workspace shutdown. Restart it to resume.');
      if (!(await this.store.db.get('SELECT id FROM agent_groups WHERE id=?', selection.targetAgentId)))
        throw new WorkspaceError(400, `Target agent not found: ${selection.targetAgentId}`);
      const agent = openReadonly(path.join(root, 'agents', selection.sourceAgentId, 'agent', 'openclaw-agent.sqlite'));
      try {
        // A SQLite read transaction gives each agent import a coherent source snapshot, including its WAL.
        agent.exec('BEGIN');
        const nodes = agent.prepare('SELECT * FROM session_nodes ORDER BY created_at').all() as Row[];
        for (const node of nodes) {
          if (this.aborted) throw new Error('Import stopped; restart the import to resume.');
          const entry = JSON.parse(node.entry_json);
          const key = `openclaw:${hash(root)}:${selection.sourceAgentId}:${node.session_key}`;
          const previous = await this.store.db.get<{ target_id: string }>(
            'SELECT target_id FROM ws_imports WHERE source_key=?',
            key,
          );
          const id = previous?.target_id ?? `import-${hash(key).slice(0, 28)}`;
          if (previous && (await this.store.getSession(id)).agentId !== selection.targetAgentId)
            throw new WorkspaceError(
              409,
              'This history is already mapped to another agent. Keep its original mapping.',
            );
          const p = node.category ? projectIds.get(node.category) : undefined;
          const project = p ? await this.store.getProject(p) : undefined;
          const ownDirectory = entry.spawnedCwd;
          const session = await this.store.addSession({
            id,
            agentId: selection.targetAgentId,
            origin: 'openclaw',
            sourceKey: key,
            projectId: p,
            title: String(
              node.label || entry.label || node.display_name || entry.displayName || 'Imported conversation',
            ).slice(0, 200),
            customTitle: false,
            directories: ownDirectory
              ? [{ id: hash(ownDirectory).slice(0, 12), path: ownDirectory, readonly: false }]
              : (project?.directories ?? []),
            pinned: !!node.pinned_at,
            archived: !!node.archived_at || !!node.spawned_by,
            createdAt: iso(node.created_at ?? entry.createdAt ?? node.updated_at),
            updatedAt: iso(node.last_activity_at ?? node.updated_at),
          });
          if (previous)
            await this.store.updateSession(
              id,
              {
                title: String(
                  node.label || entry.label || node.display_name || entry.displayName || 'Imported conversation',
                ).slice(0, 200),
              },
              true,
            );
          const windows = agent
            .prepare('SELECT session_id FROM session_windows WHERE session_key=? ORDER BY created_at')
            .all(node.session_key) as Array<{ session_id: string }>;
          if (!windows.some((w) => w.session_id === node.current_session_id))
            windows.push({ session_id: node.current_session_id });
          for (const window of windows) {
            if (!window.session_id) continue;
            let after = -1;
            while (!this.aborted) {
              const rows = agent
                .prepare(
                  'SELECT seq,event_json,event_zstd,created_at FROM transcript_events WHERE session_id=? AND seq>? ORDER BY seq LIMIT 300',
                )
                .all(window.session_id, after) as Row[];
              if (!rows.length) break;
              await this.store.db.transaction(async () => {
                for (const row of rows) {
                  const event = this.decode(row);
                  if (event)
                    await this.importEvent(root, session, `${window.session_id}:${row.seq}`, event, row.created_at);
                }
              });
              after = rows[rows.length - 1].seq;
              this.changed();
              await new Promise((resolve) => setTimeout(resolve, 0));
            }
            const archives = agent
              .prepare('SELECT generation,encoding,archive_blob FROM session_transcript_archives WHERE session_id=?')
              .all(window.session_id) as Row[];
            for (const archive of archives)
              await this.importArchive(
                root,
                session,
                `${window.session_id}:archive:${archive.generation}`,
                archive.archive_blob,
                archive.encoding,
              );
            const cold = agent
              .prepare(
                'SELECT generation,storage,archive_blob FROM session_transcript_cold_archives WHERE session_id=?',
              )
              .all(window.session_id) as Row[];
            for (const archive of cold) {
              if (archive.archive_blob)
                await this.importArchive(
                  root,
                  session,
                  `${window.session_id}:cold:${archive.generation}`,
                  archive.archive_blob,
                  'zstd',
                );
              else
                this.warning(
                  `Cold archive ${window.session_id}/${archive.generation} is stored outside SQLite (${archive.storage}); it was not copied.`,
                );
            }
          }
          const summary =
            typeof entry.activitySummary === 'string'
              ? entry.activitySummary
              : (entry.activitySummary?.text ?? entry.activitySummary?.summary);
          if (summary && !(await this.store.document('session', id)).revision)
            await this.store.saveDocument('session', id, String(summary), 0, 'openclaw');
          await this.store.db.run(
            'INSERT INTO ws_imports (source_key,target_id,imported_at) VALUES (?,?,?) ON CONFLICT(source_key) DO UPDATE SET imported_at=excluded.imported_at',
            key,
            id,
            new Date().toISOString(),
          );
          this.progress.sessions++;
          this.changed();
        }
        agent.exec('ROLLBACK');
      } finally {
        agent.close();
      }
    }
  }

  private decompress(blob: Buffer, encoding = 'zstd'): string {
    if (/gzip|gz/i.test(encoding) || (blob[0] === 0x1f && blob[1] === 0x8b))
      return zlib.gunzipSync(blob, { maxOutputLength: 128 * 1024 * 1024 }).toString('utf8');
    if (/zstd/i.test(encoding) || blob.readUInt32LE(0) === 0xfd2fb528) {
      const decompress = (
        zlib as unknown as { zstdDecompressSync?: (b: Buffer, options: { maxOutputLength: number }) => Buffer }
      ).zstdDecompressSync;
      if (!decompress)
        throw new WorkspaceError(501, 'Compressed OpenClaw history requires a Node release with zstd support.');
      return decompress(blob, { maxOutputLength: 128 * 1024 * 1024 }).toString('utf8');
    }
    return blob.toString('utf8');
  }

  private decode(row: Row): Row | null {
    try {
      return JSON.parse(row.event_json ?? this.decompress(row.event_zstd));
    } catch (error) {
      this.warning(`Transcript event ${row.seq} could not be decoded: ${String(error)}`);
      return null;
    }
  }

  private async importArchive(
    root: string,
    session: WorkspaceSession,
    archiveId: string,
    blob: Buffer,
    encoding: string,
  ) {
    if (!blob) return;
    try {
      const text = this.decompress(blob, encoding);
      let events: Row[];
      if (text.trim().startsWith('[')) events = JSON.parse(text);
      else
        events = text
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      for (let i = 0; i < events.length; i++) {
        if (this.aborted) return;
        await this.importEvent(root, session, `${archiveId}:${i}`, events[i], session.createdAt);
        if (i % 300 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } catch (error) {
      this.warning(`Archive ${archiveId} could not be imported: ${String(error)}`);
    }
  }

  private async importEvent(root: string, session: WorkspaceSession, sourceId: string, event: Row, created: unknown) {
    const message = event.message;
    if (!message || !['user', 'assistant', 'toolResult', 'tool'].includes(message.role)) return;
    const id = `${session.id}:event:${event.id ?? sourceId}`;
    if (await this.store.db.get('SELECT id FROM ws_messages WHERE id=?', id)) return;
    const blocks =
      typeof message.content === 'string'
        ? [{ type: 'text', text: message.content }]
        : Array.isArray(message.content)
          ? message.content
          : [];
    const text = blocks
      .filter((block: Row) => block.type === 'text' && typeof block.text === 'string')
      .map((block: Row) => block.text)
      .join('\n\n');
    const tools = blocks
      .filter((block: Row) => block.type === 'toolCall' || block.type === 'tool_use')
      .map((block: Row) => ({ id: block.id, name: block.name, input: block.arguments ?? block.input }));
    const files: WorkspaceMessage['files'] = [];
    for (const block of blocks) {
      if (block.type === 'image' && block.data && typeof block.data === 'string') {
        const fileId = hash(`${id}:${files.length}`).slice(0, 32);
        const mime = String(block.mimeType ?? 'image/png');
        const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
        await this.saveFile(session.id, fileId, `image.${ext}`, Buffer.from(block.data, 'base64'), mime);
        files.push({ id: fileId, name: `image.${ext}`, mime });
      }
    }
    // Copy local inbound media references only; importing never fetches network URLs or follows arbitrary host paths.
    for (const reference of text.matchAll(/media:\/\/inbound\/([^\s<>"')]+)/g)) {
      let name: string;
      try {
        name = decodeURIComponent(reference[1]);
      } catch {
        this.warning('An attachment reference had invalid URL encoding.');
        continue;
      }
      if (path.basename(name) !== name || name.includes('\0')) continue;
      const source = path.join(root, 'media', 'inbound', name);
      if (!fs.existsSync(source) || fs.lstatSync(source).isSymbolicLink()) {
        this.progress.unavailableFiles++;
        continue;
      }
      const fileId = hash(`${id}:${name}`).slice(0, 32);
      await this.saveFile(session.id, fileId, name, fs.readFileSync(source));
      files.push({ id: fileId, name });
    }
    const role = message.role === 'toolResult' || message.role === 'tool' ? 'tool' : message.role;
    if (!text && !files.length && !tools.length) return;
    const added = await this.store.putMessage({
      id,
      sessionId: session.id,
      role,
      kind: role === 'tool' ? 'tool-result' : 'chat',
      text,
      timestamp: iso(event.timestamp ?? message.timestamp ?? created),
      source: 'openclaw',
      files,
      data: {
        sourceEventId: event.id ?? sourceId,
        ...(tools.length ? { tools } : {}),
        ...(message.toolName ? { toolName: message.toolName } : {}),
      },
    });
    if (added) this.progress.messages++;
  }

  private async saveFile(sessionId: string, id: string, filename: string, data: Buffer, mime?: string) {
    const relative = `${sessionId}/${id}`;
    const dir = path.join(this.filesRoot, sessionId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(this.filesRoot, relative);
    if (!fs.existsSync(file)) fs.writeFileSync(file, data, { mode: 0o600, flag: 'wx' });
    await this.store.db.run(
      'INSERT INTO ws_files (id,session_id,filename,path,mime) VALUES (?,?,?,?,?) ON CONFLICT(id) DO NOTHING',
      id,
      sessionId,
      filename,
      relative,
      mime ?? null,
    );
    this.progress.files++;
  }
}
