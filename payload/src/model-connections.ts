import { getDb } from './db/connection.js';
import { readEnvFile } from './env.js';

export type ConnectionModel = { id: string; context: number; output: number; image: boolean };
export type ModelConnection = {
  id: string;
  name: string;
  endpoint: string;
  apiType: 'openai-compatible' | 'openai-responses' | 'anthropic';
  models: ConnectionModel[];
  revision: number;
};
export class ModelSettingsError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const fail = (message: string): never => {
  throw new ModelSettingsError(400, message);
};
export function parseConnection(input: any): Omit<ModelConnection, 'revision'> {
  if (
    !input ||
    typeof input !== 'object' ||
    Object.keys(input).some((k) => !['id', 'name', 'endpoint', 'apiType', 'models', 'revision'].includes(k))
  )
    return fail('Send connection metadata only. Credentials belong in the gateway.');
  const { id, name, endpoint, apiType, models } = input;
  if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(id))
    return fail('Connection ID must use lowercase letters, numbers and hyphens.');
  if (typeof name !== 'string' || !name.trim() || name.length > 100) return fail('Enter a connection name.');
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return fail('Enter a valid HTTPS API base URL.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    return fail('Use an HTTPS base URL without credentials, query parameters or fragments.');
  if (!['openai-compatible', 'openai-responses', 'anthropic'].includes(apiType))
    return fail('Choose a supported API protocol.');
  if (!Array.isArray(models) || !models.length || models.length > 100) return fail('Add between 1 and 100 models.');
  const seen = new Set<string>();
  const parsed = models.map((m: any) => {
    if (!m || typeof m.id !== 'string' || !/^[\w./:-]{1,160}$/.test(m.id) || seen.has(m.id))
      return fail('Model IDs must be valid and unique within the connection.');
    seen.add(m.id);
    if (
      !Number.isSafeInteger(m.context) ||
      !Number.isSafeInteger(m.output) ||
      m.output < 1 ||
      m.context < m.output ||
      m.context > 10_000_000
    )
      return fail('Each model needs valid context and output token limits; output cannot exceed context.');
    return { id: m.id, context: m.context, output: m.output, image: m.image === true };
  });
  return { id, name: name.trim(), endpoint: url.toString().replace(/\/$/, ''), apiType, models: parsed };
}
export async function listModelConnections(): Promise<ModelConnection[]> {
  const rows = await getDb().all<{ document: string; revision: number }>(
    'SELECT document,revision FROM model_connections ORDER BY id',
  );
  return rows.map((r) => ({ ...JSON.parse(r.document), revision: r.revision }));
}
export async function connectionForModel(model?: string): Promise<ModelConnection | undefined> {
  if (!model?.includes('/') || !(await getDb().hasTable('model_connections'))) return;
  return (await listModelConnections()).find((c) => c.id === model.slice(0, model.indexOf('/')));
}
export async function saveModelConnection(
  input: unknown,
  create = false,
  prepare?: () => Promise<void | (() => void)>,
  extraReferences?: () => Promise<string[]>,
) {
  const c = parseConnection(input);
  const db = getDb();
  const revision = (input as any).revision;
  if (create) {
    if (await db.get('SELECT id FROM model_connections WHERE id=?', c.id))
      throw new ModelSettingsError(409, 'That connection ID already exists.');
    const result = await db.run(
      'INSERT INTO model_connections (id,document,revision,updated_at) VALUES (?,?,1,?) ON CONFLICT(id) DO NOTHING',
      c.id,
      JSON.stringify(c),
      new Date().toISOString(),
    );
    if (!result.changes) throw new ModelSettingsError(409, 'That connection ID already exists.');
  } else {
    if (!Number.isSafeInteger(revision)) return fail('Reload this connection before saving.');
    const checkReferences = async () => {
      const rows = await db.all<{ model: string }>(
        "SELECT model FROM container_configs WHERE provider='opencode' AND model IS NOT NULL",
      );
      const references = [...rows.map((r) => r.model), ...((await extraReferences?.()) ?? [])];
      if (
        references.some((model) => model.startsWith(c.id + '/') && !c.models.some((m) => model === `${c.id}/${m.id}`))
      )
        throw new ModelSettingsError(
          409,
          'A removed model is still selected by an agent or conversation. Change those selections first.',
        );
    };
    await checkReferences();
    const old = await db.get<{ revision: number }>('SELECT revision FROM model_connections WHERE id=?', c.id);
    if (old?.revision !== revision)
      throw new ModelSettingsError(409, 'This connection changed elsewhere. Reload before saving.');
    const release = await prepare?.();
    try {
      await db.transaction(async () => {
        await checkReferences();
        const result = await db.run(
          'UPDATE model_connections SET document=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?',
          JSON.stringify(c),
          new Date().toISOString(),
          c.id,
          revision,
        );
        if (!result.changes)
          throw new ModelSettingsError(409, 'This connection changed elsewhere. Reload it before saving.');
      });
    } finally {
      release?.();
    }
  }
  return (await listModelConnections()).find((v) => v.id === c.id)!;
}
/** Import the existing operator-owned connection once; no credential is read. */
export async function seedEnvironmentConnection() {
  const keys = [
    'OPENCODE_PROVIDER',
    'OPENCODE_MODEL',
    'OPENCODE_SMALL_MODEL',
    'OPENCODE_BASE_URL',
    'OPENCODE_API_TYPE',
    'OPENCODE_MODEL_CONTEXT_LIMIT',
    'OPENCODE_MODEL_OUTPUT_LIMIT',
    'OPENCODE_MODEL_INPUT_MODALITIES',
  ];
  const file = readEnvFile(keys);
  const env = (k: string) => process.env[k] ?? file[k];
  const id = env('OPENCODE_PROVIDER'),
    endpoint = env('OPENCODE_BASE_URL'),
    model = env('OPENCODE_MODEL');
  if (!id || !endpoint || !endpoint.startsWith('https://') || !model || !model.startsWith(id + '/')) return;
  if (await getDb().get('SELECT id FROM model_connections WHERE id=?', id)) return;
  const context = Number(env('OPENCODE_MODEL_CONTEXT_LIMIT')),
    output = Number(env('OPENCODE_MODEL_OUTPUT_LIMIT'));
  if (!context || !output) return; // Missing model metadata remains an environment-managed connection.
  const name = new URL(endpoint).hostname.endsWith('.bytepluses.com') ? 'BytePlus' : id;
  const models = [
    ...new Set([model, env('OPENCODE_SMALL_MODEL')].filter((m): m is string => !!m && m.startsWith(id + '/'))),
  ].map((m) => ({
    id: m.slice(id.length + 1),
    context,
    output,
    image: (env('OPENCODE_MODEL_INPUT_MODALITIES') ?? '').split(',').includes('image'),
  }));
  await saveModelConnection(
    { id, name, endpoint, apiType: env('OPENCODE_API_TYPE') || 'openai-compatible', models },
    true,
  );
}

export async function removeModelConnection(id: string, revision: number, extraReferences?: () => Promise<string[]>) {
  const db = getDb();
  return db.transaction(async () => {
    const references = await db.all<{ model: string }>(
      "SELECT model FROM container_configs WHERE provider='opencode' AND model IS NOT NULL",
    );
    if (
      [...references.map((r) => r.model), ...((await extraReferences?.()) ?? [])].some((model) =>
        model.startsWith(id + '/'),
      )
    )
      throw new ModelSettingsError(409, 'This connection is selected by an agent. Change the agent’s model first.');
    const result = await db.run('DELETE FROM model_connections WHERE id=? AND revision=?', id, revision);
    if (!result.changes)
      throw new ModelSettingsError(409, 'This connection changed elsewhere. Reload before removing it.');
  });
}
