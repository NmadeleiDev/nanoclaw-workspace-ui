import type { DbDriver } from '../../db/driver.js';
import { registerMigration, type ModuleMigration } from '../../db/migrations/index.js';

export const workspaceMigration: ModuleMigration = {
  version: 1,
  name: 'module:workspace-ui:initial',
  async up(db) {
    await db.exec(`
      CREATE TABLE ws_settings (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE ws_projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
        directories TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
        position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE ws_sessions (
        id TEXT PRIMARY KEY, native_session_id TEXT UNIQUE, agent_id TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
        project_id TEXT REFERENCES ws_projects(id) ON DELETE SET NULL,
        title TEXT NOT NULL, custom_title INTEGER NOT NULL DEFAULT 0,
        directories TEXT NOT NULL, primary_directory_id TEXT, model TEXT, effort TEXT,
        pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
        origin TEXT NOT NULL, source_key TEXT UNIQUE, continued_from TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX ws_sessions_agent ON ws_sessions(agent_id, updated_at);
      CREATE INDEX ws_sessions_project ON ws_sessions(project_id);
      CREATE TABLE ws_scratchpads (
        scope TEXT NOT NULL, scope_id TEXT NOT NULL, revision INTEGER NOT NULL,
        markdown TEXT NOT NULL, author TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (scope, scope_id)
      );
      CREATE TABLE ws_revisions (
        scope TEXT NOT NULL, scope_id TEXT NOT NULL, revision INTEGER NOT NULL,
        markdown TEXT NOT NULL, author TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (scope, scope_id, revision)
      );
      CREATE TABLE ws_messages (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES ws_sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
        timestamp TEXT NOT NULL, source TEXT NOT NULL, files TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX ws_messages_session ON ws_messages(session_id, timestamp, id);
      CREATE TABLE ws_cursors (session_id TEXT NOT NULL, direction TEXT NOT NULL, cursor INTEGER NOT NULL,
        PRIMARY KEY (session_id, direction));
      CREATE TABLE ws_live (session_id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE ws_utility_jobs (
        id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, task TEXT NOT NULL,
        source_key TEXT NOT NULL, state TEXT NOT NULL, due_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, error TEXT, updated_at TEXT NOT NULL
      );
      CREATE INDEX ws_utility_due ON ws_utility_jobs(state, due_at);
      CREATE TABLE ws_imports (source_key TEXT PRIMARY KEY, target_id TEXT NOT NULL, imported_at TEXT NOT NULL);
      CREATE TABLE ws_files (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES ws_sessions(id) ON DELETE CASCADE,
        filename TEXT NOT NULL, path TEXT NOT NULL, mime TEXT);
    `);
  },
};

registerMigration(workspaceMigration);

export const workspaceNotificationsMigration: ModuleMigration = {
  version: 2,
  name: 'module:workspace-ui:notifications',
  async up(db) {
    await db.exec(`
      CREATE TABLE ws_devices (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
        origin TEXT NOT NULL, name TEXT NOT NULL, installation_id TEXT, created_at TEXT NOT NULL,
        last_seen TEXT NOT NULL, revoked_at TEXT, push_enabled INTEGER NOT NULL DEFAULT 0,
        subscription TEXT, push_error TEXT, last_push_at TEXT, last_push_status TEXT);
      CREATE INDEX ws_devices_owner ON ws_devices(owner_id);
      CREATE TABLE ws_notification_preferences (owner_id TEXT NOT NULL, scope TEXT NOT NULL, scope_id TEXT NOT NULL,
        value TEXT NOT NULL, PRIMARY KEY(owner_id,scope,scope_id));
      CREATE TABLE ws_activity (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES ws_sessions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, text TEXT NOT NULL, source_id TEXT NOT NULL UNIQUE, request_id TEXT, message_id TEXT,
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
      CREATE INDEX ws_activity_created ON ws_activity(created_at);
      CREATE TABLE ws_activity_read (owner_id TEXT NOT NULL, activity_id TEXT NOT NULL REFERENCES ws_activity(id) ON DELETE CASCADE,
        PRIMARY KEY(owner_id,activity_id));
      CREATE TABLE ws_push_outbox (activity_id TEXT NOT NULL REFERENCES ws_activity(id) ON DELETE CASCADE,
        device_id TEXT NOT NULL REFERENCES ws_devices(id) ON DELETE CASCADE, state TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, due_at TEXT NOT NULL, error TEXT,
        PRIMARY KEY(activity_id,device_id));
      CREATE TABLE ws_notification_cursors (session_id TEXT PRIMARY KEY, cursor INTEGER NOT NULL);
    `);
    await db.run('INSERT INTO ws_settings (id,value) VALUES (?,?)', 'notification-baseline', new Date().toISOString());
  },
};
registerMigration(workspaceNotificationsMigration);

export const workspaceModelConnectionsMigration: ModuleMigration = {
  version: 3,
  name: 'module:workspace-ui:model-connections',
  async up(db) {
    await db.exec('CREATE TABLE model_connections (id TEXT PRIMARY KEY, document TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL)');
  },
};
registerMigration(workspaceModelConnectionsMigration);

export const workspaceActivitySummariesMigration: ModuleMigration = {
  version: 4,
  name: 'module:workspace-ui:activity-summaries',
  async up(db) {
    await db.exec(`CREATE TABLE ws_activity_summaries (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES ws_sessions(id) ON DELETE CASCADE,
      group_key TEXT NOT NULL, source_key TEXT NOT NULL, evidence TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL,
      UNIQUE(session_id,group_key)
    );`);
  },
};
registerMigration(workspaceActivitySummariesMigration);

// Preserve the effective MyWhispr configuration of existing workspace installations.
export const workspaceSpeechBackendsMigration = {
  version: 5,
  name: 'module:workspace-ui:speech-backends',
  async up(db: DbDriver) {
    const row = await db.get<{value:string}>('SELECT value FROM ws_settings WHERE id=?','workspace');
    if (!row) return;
    const settings = JSON.parse(row.value);
    if (!settings.speech?.backend) {
      settings.speech = {enabled:true, executable:'', model:'large-v3-v20240930_626MB', language:'auto', ...settings.speech, backend:'mywhispr', endpoint:'http://127.0.0.1:8080'};
      await db.run('UPDATE ws_settings SET value=? WHERE id=?',JSON.stringify(settings),'workspace');
    }
  },
} satisfies ModuleMigration;
registerMigration(workspaceSpeechBackendsMigration);

export const workspaceActivityHistoryMigration: ModuleMigration = {
  version: 6,
  name: 'module:workspace-ui:activity-history',
  async up(db) {
    await db.exec(`CREATE TABLE ws_activity_cursors (
      session_id TEXT PRIMARY KEY REFERENCES ws_sessions(id) ON DELETE CASCADE,
      cursor INTEGER NOT NULL, value TEXT NOT NULL
    )`);
  },
};
registerMigration(workspaceActivityHistoryMigration);

export const workspaceDismissedRequestsMigration: ModuleMigration = {
  version: 7,
  name: 'module:workspace-ui:dismissed-requests',
  async up(db) {
    await db.exec('CREATE TABLE ws_dismissed_requests (request_id TEXT PRIMARY KEY, dismissed_at TEXT NOT NULL)');
  },
};
registerMigration(workspaceDismissedRequestsMigration);

// Re-read retained mailbox events once to recover output hidden by the former UI.
export const workspaceTimelineMigration: ModuleMigration = {
  version: 8,
  name: 'module:workspace-ui:ordered-output',
  async up(db) {
    await db.run("UPDATE ws_activity_cursors SET cursor=0,value=? WHERE cursor>0", JSON.stringify({running:false,tools:{},texts:{}}));
    await db.run("UPDATE ws_cursors SET cursor=0 WHERE direction='event' AND cursor>0");
  },
};
registerMigration(workspaceTimelineMigration);

registerMigration({version:9,name:'module:workspace-ui:document-viewer',async up(db){
 await db.exec(`CREATE TABLE ws_viewer_documents(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES ws_sessions(id) ON DELETE CASCADE,source TEXT NOT NULL);
 CREATE TABLE ws_viewer_requests(seq INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL REFERENCES ws_sessions(id) ON DELETE CASCADE,request_id TEXT UNIQUE NOT NULL,action TEXT NOT NULL,document_id TEXT NOT NULL);
 CREATE INDEX ws_viewer_requests_session ON ws_viewer_requests(session_id,seq);`);
}});
