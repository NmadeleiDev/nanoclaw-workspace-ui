import { workspaceModelContribution } from './modules/workspace-ui/model-provider.js';
import { registerProviderContainerConfig } from './providers/provider-container-registry.js';
import { registerProviderHostContract, getProviderHostContract } from './provider-contracts/registry.js';
import './provider-contracts/claude.js';
registerProviderContainerConfig('opencode', () => ({}));
registerProviderHostContract('opencode', { ...getProviderHostContract('claude')!, legacyHostAdapter: 'required' });
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { initTestDb, closeDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import './modules/workspace-ui/migration.js';
import './providers/index.js';
import { ensureContainerConfig } from './db/container-configs.js';
import { parseConnection, saveModelConnection, listModelConnections, connectionForModel } from './model-connections.js';
import { agentModelSettings, updateAgentModelSettings } from './agent-model-settings.js';
import { getProviderContainerConfig } from './providers/provider-container-registry.js';
let db: Awaited<ReturnType<typeof initTestDb>>;
const definition = () => ({
  id: 'fixture',
  name: 'Fixture API',
  endpoint: 'https://api.example.test/v1',
  apiType: 'openai-compatible',
  models: [
    { id: 'small', context: 32000, output: 4096, image: false },
    { id: 'large', context: 128000, output: 8192, image: true },
  ],
});
beforeEach(async () => {
  db = await initTestDb();
  await runMigrations(db);
  await db.run(
    'INSERT INTO agent_groups (id,name,folder,created_at) VALUES (?,?,?,?)',
    'agent',
    'Agent',
    'fixture',
    new Date().toISOString(),
  );
  await ensureContainerConfig('agent', 'opencode');
});
afterEach(async () => {
  await closeDb();
  vi.unstubAllEnvs();
});
it('rejects secret-bearing URLs, invalid limits, duplicate models and credential fields', () => {
  for (const endpoint of [
    'http://example.test/v1',
    'https://user:secret@example.test/v1',
    'https://example.test/v1?api_key=secret',
    'https://example.test/v1#secret',
  ])
    expect(() => parseConnection({ ...definition(), endpoint })).toThrow();
  expect(() => parseConnection({ ...definition(), apiKey: 'secret' })).toThrow('Credentials');
  expect(() => parseConnection({ ...definition(), models: [{ id: 'm', context: 1, output: 2 }] })).toThrow('limits');
  expect(() => parseConnection({ ...definition(), models: [definition().models[0], definition().models[0]] })).toThrow(
    'unique',
  );
});
it('persists exact metadata and prevents lost updates before stopping any runtime', async () => {
  const first = await saveModelConnection(definition(), true);
  expect(first.revision).toBe(1);
  const prepare = vi.fn(async () => {});
  const second = await saveModelConnection({ ...first, name: 'Renamed' }, false, prepare);
  expect(second.name).toBe('Renamed');
  expect(prepare).toHaveBeenCalledOnce();
  prepare.mockClear();
  await expect(saveModelConnection({ ...first, name: 'Stale' }, false, prepare)).rejects.toThrow('changed elsewhere');
  expect(prepare).not.toHaveBeenCalled();
  expect((await listModelConnections())[0].name).toBe('Renamed');
});
it('keeps referenced models and resolves the connection by exact namespace', async () => {
  const c = await saveModelConnection(definition(), true);
  await db.run('UPDATE container_configs SET model=? WHERE agent_group_id=?', 'fixture/small', 'agent');
  await expect(saveModelConnection({ ...c, models: [c.models[1]] })).rejects.toThrow('still selected');
  expect((await connectionForModel('fixture/small'))?.id).toBe('fixture');
  expect(await connectionForModel('fixture-other/small')).toBeUndefined();
});
it('uses the selected model endpoint, limits and modalities rather than global defaults', async () => {
  await saveModelConnection(definition(), true);
  const contribution = await workspaceModelContribution('opencode', 'fixture/large', { env: { OPENCODE_PROVIDER: 'wrong', OPENCODE_BASE_URL: 'https://wrong.test/v1' } });
  expect(contribution.env).toMatchObject({
    OPENCODE_PROVIDER: 'fixture',
    OPENCODE_MODEL: 'fixture/large',
    OPENCODE_SMALL_MODEL: 'fixture/large',
    OPENCODE_BASE_URL: 'https://api.example.test/v1',
    OPENCODE_MODEL_CONTEXT_LIMIT: '128000',
    OPENCODE_MODEL_OUTPUT_LIMIT: '8192',
    OPENCODE_MODEL_INPUT_MODALITIES: 'text,image',
  });
  expect(contribution.env?.OPENCODE_AUTH_MODE).toBe('api-key');
});
it('changes agent defaults only after an idle handoff and keeps unrelated config', async () => {
  await saveModelConnection(definition(), true);
  const old = await agentModelSettings('agent');
  const prepare = vi.fn(async () => {
    throw Error('Agent busy');
  });
  const input = { provider: 'opencode', model: 'fixture/small', effort: 'high', revision: old.revision };
  await expect(updateAgentModelSettings('agent', input, prepare)).rejects.toThrow('busy');
  expect((await agentModelSettings('agent')).model).toBe(old.model);
  const saved = await updateAgentModelSettings('agent', input, async () => {});
  expect(saved).toMatchObject({ model: 'fixture/small', effort: 'high' });
  expect(await db.get('SELECT cli_scope FROM container_configs WHERE agent_group_id=?', 'agent')).toMatchObject({
    cli_scope: 'group',
  });
  await expect(updateAgentModelSettings('agent', input, async () => {})).rejects.toThrow('changed elsewhere');
});
it('rejects uninstalled runners, unknown models and unconfirmed runner switches', async () => {
  const old = await agentModelSettings('agent');
  const prepare = vi.fn(async () => {});
  for (const [provider, model] of [
    ['missing', 'm'],
    ['opencode', 'unknown/m'],
    ['claude', ''],
  ])
    await expect(
      updateAgentModelSettings('agent', { provider, model, effort: '', revision: old.revision }, prepare),
    ).rejects.toThrow();
  expect(prepare).not.toHaveBeenCalled();
  const saved = await updateAgentModelSettings(
    'agent',
    { provider: 'claude', model: '', effort: '', revision: old.revision, confirmProviderChange: true },
    prepare,
  );
  expect(saved.provider).toBe('claude');
});

it('removes only unused connections at the revision the operator reviewed', async () => {
  const { removeModelConnection } = await import('./model-connections.js');
  const c = await saveModelConnection(definition(), true);
  await expect(removeModelConnection(c.id, 0)).rejects.toThrow('changed elsewhere');
  await db.run('UPDATE container_configs SET model=? WHERE agent_group_id=?', 'fixture/small', 'agent');
  await expect(removeModelConnection(c.id, c.revision)).rejects.toThrow('selected by an agent');
  await db.run('UPDATE container_configs SET model=NULL WHERE agent_group_id=?', 'agent');
  await removeModelConnection(c.id, c.revision);
  expect(await listModelConnections()).toEqual([]);
});

it('releases agent admission after committing a settings change', async () => {
  await saveModelConnection(definition(), true);
  const old = await agentModelSettings('agent');
  const release = vi.fn();
  await updateAgentModelSettings(
    'agent',
    { provider: 'opencode', model: 'fixture/small', effort: '', revision: old.revision },
    async () => release,
  );
  expect(release).toHaveBeenCalledOnce();
  const c = (await listModelConnections())[0];
  release.mockClear();
  await saveModelConnection({ ...c, name: 'Changed' }, false, async () => release);
  expect(release).toHaveBeenCalledOnce();
});

it('rechecks references and model availability after an asynchronous idle handoff', async () => {
  const c = await saveModelConnection(definition(), true);
  const refs: string[] = [];
  await expect(
    saveModelConnection(
      { ...c, models: [c.models[1]] },
      false,
      async () => {
        refs.push('fixture/small');
      },
      async () => refs,
    ),
  ).rejects.toThrow('still selected');
  expect((await listModelConnections())[0].models).toHaveLength(2);
  const old = await agentModelSettings('agent');
  await expect(
    updateAgentModelSettings(
      'agent',
      { provider: 'opencode', model: 'fixture/small', effort: '', revision: old.revision },
      async () => {
        await saveModelConnection({ ...c, models: [c.models[1]] });
      },
    ),
  ).rejects.toThrow('model changed');
  expect((await agentModelSettings('agent')).model).not.toBe('fixture/small');
});
