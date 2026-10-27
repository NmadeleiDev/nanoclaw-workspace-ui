import { createHash } from 'node:crypto';
import { getDb } from './db/connection.js';
import { DEFAULT_MODEL } from './config.js';
import { listProviderContainerConfigNames } from './providers/provider-container-registry.js';
import { listModelConnections, ModelSettingsError } from './model-connections.js';

export async function agentModelSettings(id: string) {
  const row = await getDb().get<any>(
    'SELECT a.name,c.* FROM agent_groups a JOIN container_configs c ON c.agent_group_id=a.id WHERE a.id=?',
    id,
  );
  if (!row) throw new ModelSettingsError(404, 'Agent configuration not found.');
  return {
    id,
    name: row.name,
    provider: row.provider || 'claude',
    model: row.model || DEFAULT_MODEL || '',
    effort: row.effort || '',
    revision: createHash('sha256').update(JSON.stringify(row)).digest('hex'),
    providers: listProviderContainerConfigNames().sort(),
    connections: await listModelConnections(),
  };
}
export async function updateAgentModelSettings(id: string, input: any, prepare: () => Promise<void | (() => void)>) {
  const old = await agentModelSettings(id);
  if (
    !input ||
    Object.keys(input).some((k) => !['provider', 'model', 'effort', 'revision', 'confirmProviderChange'].includes(k))
  )
    throw new ModelSettingsError(400, 'Only agent runner, model and reasoning settings can be edited here.');
  if (input.revision !== old.revision)
    throw new ModelSettingsError(409, 'This agent changed elsewhere. Reload before saving.');
  if (!old.providers.includes(input.provider)) throw new ModelSettingsError(400, 'Choose an installed agent runner.');
  if (typeof input.model !== 'string' || input.model.length > 200 || /\s/.test(input.model))
    throw new ModelSettingsError(400, 'Enter a valid model ID.');
  if (!['', 'low', 'medium', 'high', 'xhigh', 'max'].includes(input.effort))
    throw new ModelSettingsError(400, 'Choose a valid reasoning effort.');
  if (
    input.provider === 'opencode' &&
    !old.connections.some((c) => c.models.some((m) => `${c.id}/${m.id}` === input.model))
  )
    throw new ModelSettingsError(400, 'Add this model to an API connection before selecting it.');
  if (input.provider !== old.provider && input.confirmProviderChange !== true)
    throw new ModelSettingsError(
      409,
      'Confirm switching agent runners. Provider-specific conversation context does not transfer.',
    );
  const release = await prepare();
  try {
    await getDb().transaction(async () => {
      const current = await agentModelSettings(id);
      if (
        input.provider === 'opencode' &&
        !current.connections.some((c) => c.models.some((m) => `${c.id}/${m.id}` === input.model))
      )
        throw new ModelSettingsError(409, 'This model changed while saving. Reload the agent settings.');
      if (current.revision !== input.revision)
        throw new ModelSettingsError(409, 'This agent changed elsewhere. Reload before saving.');
      await getDb().run(
        "UPDATE container_configs SET provider=?,model=?,effort=?,speed=CASE WHEN COALESCE(provider,'claude')=? THEN speed ELSE NULL END,updated_at=? WHERE agent_group_id=?",
        input.provider === 'claude' ? null : input.provider,
        input.model || null,
        input.effort || null,
        input.provider,
        new Date().toISOString(),
        id,
      );
    });
  } finally {
    release?.();
  }
  return agentModelSettings(id);
}
