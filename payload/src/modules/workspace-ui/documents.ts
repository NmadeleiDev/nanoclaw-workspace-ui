import { EventEmitter } from 'node:events';
export const documentEvents = new EventEmitter();
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { GROUPS_DIR } from '../../config.js';
import { inspectDirectories } from './directories.js';
import { AnchoredDir } from '../../anchored-dir.js';
import { WorkspaceError } from './types.js';
import type { WorkspaceService } from './service.js';
const hash = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
export class WorkspaceDocuments {
  constructor(readonly service: WorkspaceService) {}
  async list(session: string) {
    await this.service.store.getSession(session);
    const rows = await this.service.store.db.all<{ id: string; source: string }>(
      'SELECT id,source FROM ws_viewer_documents WHERE session_id=?',
      session,
    );
    return rows.map((row) => ({ ...row, source: JSON.parse(row.source) }));
  }
  async open(session: string, input: { path?: string; attachmentId?: string }) {
    if (
      (input.path !== undefined && typeof input.path !== 'string') ||
      (input.attachmentId !== undefined && typeof input.attachmentId !== 'string') ||
      (input.path && input.attachmentId)
    )
      throw new WorkspaceError(400, 'Choose one file path or attachment ID.');
    if (input.path) {
      const location = await this.location(session, input.path);
      location.dir.close();
      input = { path: location.actual };
    }
    const source = input.attachmentId ? { attachmentId: input.attachmentId } : { path: input.path };
    if (!source.attachmentId && (typeof source.path !== 'string' || !source.path))
      throw new WorkspaceError(400, 'Choose a document.');
    const id = hash(session + JSON.stringify(source)).slice(0, 32);
    await this.readSource(session, source);
    await this.service.store.db.run(
      'INSERT INTO ws_viewer_documents(id,session_id,source) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING',
      id,
      session,
      JSON.stringify(source),
    );
    return this.read(session, id);
  }
  async source(session: string, id: string) {
    const row = await this.service.store.db.get<{ source: string }>(
      'SELECT source FROM ws_viewer_documents WHERE id=? AND session_id=?',
      id,
      session,
    );
    if (!row) throw new WorkspaceError(404, 'Document not found.');
    return JSON.parse(row.source);
  }
  async location(sessionId: string, requested: string) {
    const session = await this.service.store.getSession(sessionId);
    const group = await this.service.store.db.get<{ folder: string }>(
      'SELECT folder FROM agent_groups WHERE id=?',
      session.agentId,
    );
    if (!group) throw new WorkspaceError(404, 'Agent not found.');
    const root = path.join(GROUPS_DIR, group.folder);
    const config = await this.service.store.db.get<{ additional_mounts: string }>(
      'SELECT additional_mounts FROM container_configs WHERE agent_group_id=?',
      session.agentId,
    );
    const additional = JSON.parse(config?.additional_mounts || '[]') as Array<{
      hostPath: string;
      containerPath: string;
      readonly?: boolean;
    }>;
    const roots = [
      { host: root, actual: '/workspace/agent', readonly: false },
      ...session.directories.map((d) => ({
        host: d.path,
        actual: `/workspace/extra/ws-${d.id}`,
        readonly: d.readonly,
      })),
      ...additional.map((d) => ({
        host: d.hostPath,
        actual: `/workspace/extra/${d.containerPath}`,
        readonly: d.readonly !== false,
      })),
    ];
    const primary = session.directories.find((d) => d.id === session.primaryDirectoryId);
    const cwd = primary ? `/workspace/extra/ws-${primary.id}` : roots[0].actual;
    const actual = path.resolve(cwd, requested);
    const match = roots
      .sort((a, b) => b.actual.length - a.actual.length)
      .find((r) => actual.startsWith(r.actual + path.sep));
    if (!match) throw new WorkspaceError(403, 'Document is outside this conversation’s folders.');
    if (match.host !== root) {
      const directory = session.directories.find((d) => d.path === match.host);
      if (
        !inspectDirectories([directory ?? { id: 'configured', path: match.host, readonly: match.readonly }])[0]?.allowed
      )
        throw new WorkspaceError(403, 'Folder access has been revoked.');
    }
    const parts = path.relative(match.actual, actual).split(path.sep);
    if (
      parts.some(
        (s) =>
          !s || s === '..' || s.startsWith('.') || /^(container\.json|credentials.*|.*\.db|.*\.pem|.*\.key)$/i.test(s),
      )
    )
      throw new WorkspaceError(403, 'Protected document path.');
    // Pin each directory: never follow agent-controlled symlinks.
    const dir = AnchoredDir.open(match.host, parts.slice(0, -1));
    if (!dir) throw new WorkspaceError(404, 'Document folder is unavailable.');
    return { dir, name: parts.at(-1)!, readonly: match.readonly, actual };
  }
  async readSource(
    session: string,
    source: any,
  ): Promise<{
    name: string;
    data: Buffer;
    mime: string;
    writable: boolean;
    size: number;
    revision: string;
    tooLarge: boolean;
  }> {
    if (source.attachmentId) {
      const row = await this.service.store.db.get<{ session_id: string }>(
        'SELECT session_id FROM ws_files WHERE id=?',
        source.attachmentId,
      );
      if (row?.session_id !== session) throw new WorkspaceError(403, 'Attachment belongs to another conversation.');
      const file = await this.service.file(source.attachmentId);
      const tooLarge = file.data.length > 20 * 1024 * 1024;
      return {
        ...file,
        data: tooLarge ? Buffer.alloc(0) : file.data,
        writable: false,
        size: file.data.length,
        revision: hash(file.data),
        tooLarge,
      };
    }
    const loc = await this.location(session, source.path);
    try {
      const fd = loc.dir.openReadFd(loc.name);
      try {
        const stat = fs.fstatSync(fd),
          tooLarge = stat.size > 20 * 1024 * 1024;
        const data = tooLarge ? Buffer.alloc(0) : fs.readFileSync(fd);
        return {
          name: loc.name,
          data,
          mime: '',
          writable: !loc.readonly && !tooLarge,
          size: stat.size,
          revision: tooLarge ? `${stat.size}:${stat.mtimeMs}` : hash(data),
          tooLarge,
        };
      } finally {
        fs.closeSync(fd);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') throw new WorkspaceError(404, 'The document is no longer available.');
      if (code === 'ELOOP' || code === 'ENOTDIR') throw new WorkspaceError(403, 'Document symlinks are not supported.');
      throw error;
    } finally {
      loc.dir.close();
    }
  }
  async download(session: string, id: string): Promise<{ name: string; data?: Buffer; fd?: number }> {
    const source = await this.source(session, id);
    if (source.attachmentId) {
      const row = await this.service.store.db.get<{ session_id: string }>(
        'SELECT session_id FROM ws_files WHERE id=?',
        source.attachmentId,
      );
      if (row?.session_id !== session) throw new WorkspaceError(403, 'Attachment belongs to another conversation.');
      return this.service.file(source.attachmentId);
    }
    const loc = await this.location(session, source.path);
    try {
      return { name: loc.name, fd: loc.dir.openReadFd(loc.name) };
    } finally {
      loc.dir.close();
    }
  }
  async read(session: string, id: string) {
    const source = await this.source(session, id),
      file = await this.readSource(session, source);
    const ext = path.extname(file.name).toLowerCase();
    const kind = file.tooLarge
      ? 'unsupported'
      : ext === '.pdf'
        ? 'pdf'
        : /\.(png|jpe?g|gif|webp|avif|bmp)$/.test(ext)
          ? 'image'
          : /\.(md|markdown)$/.test(ext)
            ? 'markdown'
            : /\.(txt|log|json|yaml|yml|toml|csv|ts|tsx|js|jsx|py|sh|css|html|xml|sql|rs|go|java|c|cpp|h)$/.test(ext)
              ? 'text'
              : 'unsupported';
    const text =
      ['text', 'markdown'].includes(kind) && file.data.length <= 2 * 1024 * 1024 && !file.data.includes(0)
        ? file.data.toString('utf8')
        : undefined;
    return {
      id,
      name: file.name,
      kind,
      revision: file.revision,
      editable: file.writable && text !== undefined,
      text,
      size: file.size,
      source,
    };
  }
  async save(session: string, id: string, text: string, revision: string) {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 2 * 1024 * 1024)
      throw new WorkspaceError(413, 'Text limit is 2 MiB.');
    const current = await this.read(session, id);
    if (!current.editable) throw new WorkspaceError(403, 'This document is read-only.');
    if (current.revision !== revision)
      throw new WorkspaceError(409, 'File changed. Copy your draft and reload the latest version.');
    const loc = await this.location(session, current.source.path);
    try {
      const fd = loc.dir.openReadFd(loc.name);
      let bytes: Buffer, mode: number;
      try {
        bytes = fs.readFileSync(fd);
        mode = fs.fstatSync(fd).mode;
      } finally {
        fs.closeSync(fd);
      }
      if (hash(bytes) !== revision) throw new WorkspaceError(409, 'File changed. Reload before saving.');
      const recovery = path.join(this.service.filesRoot, '.document-revisions');
      fs.mkdirSync(recovery, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(recovery, id + '-' + revision), bytes, { mode: 0o600 });
      loc.dir.replaceFile(loc.name, text, mode);
    } finally {
      loc.dir.close();
    }
    this.service.changed();
    documentEvents.emit('change');
    return this.read(session, id);
  }
  async present(session: string, requestId: string, action: string, input: any) {
    if (!['list', 'open', 'focus', 'refresh'].includes(action)) throw new WorkspaceError(400, 'Unknown viewer action.');
    if (action === 'list') return this.list(session);
    const document =
      action === 'open' ? await this.open(session, input) : await this.read(session, String(input.documentId));
    await this.service.store.db.run(
      'INSERT INTO ws_viewer_requests(session_id,request_id,action,document_id) VALUES(?,?,?,?) ON CONFLICT(request_id) DO NOTHING',
      session,
      requestId,
      action,
      document.id,
    );
    this.service.changed();
    documentEvents.emit('change');
    return { documentId: document.id, status: 'presentation requested' };
  }
  async requests(session: string) {
    await this.service.store.getSession(session);
    return this.service.store.db.all(
      'SELECT seq,action,document_id FROM ws_viewer_requests WHERE session_id=? ORDER BY seq',
      session,
    );
  }
}
