import { beforeEach, afterEach, it, expect } from 'bun:test';
import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from '../mailbox/sqlite/connection.js';
import { workspaceViewer } from './workspace.js';
beforeEach(() => {
  initTestSessionDb();
  getInboundDb().exec('CREATE TABLE IF NOT EXISTS workspace_context(id INTEGER PRIMARY KEY,value TEXT,control TEXT)');
  getInboundDb()
    .query('INSERT INTO workspace_context VALUES(1,?,NULL)')
    .run(JSON.stringify({ title: 'Fixture', sessionId: 'one' }));
});
afterEach(() => closeSessionDb());
it('presents documents through the correlated session mailbox and returns host errors honestly', async () => {
  const controller = new AbortController();
  const promise = workspaceViewer.handler({ operation: 'open', path: 'spec.md' }, { signal: controller.signal });
  let row: any;
  for (let i = 0; i < 50 && !row; i++) {
    await Bun.sleep(10);
    row = getOutboundDb().query('SELECT * FROM messages_out LIMIT 1').get();
  }
  expect(row).toBeTruthy();
  const content = JSON.parse(row.content);
  expect(content).toMatchObject({ action: 'workspace_viewer', operation: 'open', path: 'spec.md' });
  getInboundDb()
    .query(`INSERT INTO messages_in(id,kind,content,timestamp,status) VALUES(?,?,?,?,?)`)
    .run(
      `workspace-response-${content.requestId}`,
      'system',
      JSON.stringify({ error: 'Read access denied.' }),
      new Date().toISOString(),
      'pending',
    );
  const result = await promise;
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toContain('Read access denied.');
});
