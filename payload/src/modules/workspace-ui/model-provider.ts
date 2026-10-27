import type { ProviderContainerContribution } from '../../providers/provider-container-registry.js';
import { connectionForModel } from '../../model-connections.js';
export async function workspaceModelContribution(
  provider: string,
  model: string | undefined,
  original: ProviderContainerContribution,
): Promise<ProviderContainerContribution> {
  if (provider !== 'opencode') return original;
  const connection = await connectionForModel(model);
  if (!connection) return original;
  const selected = connection.models.find((item) => `${connection.id}/${item.id}` === model);
  if (!selected) throw new Error('The selected model is absent from its API connection.');
  return {
    ...original,
    env: {
      ...original.env,
      OPENCODE_AUTH_MODE: 'api-key',
      OPENCODE_PROVIDER: connection.id,
      OPENCODE_MODEL: model!,
      OPENCODE_SMALL_MODEL: model!,
      OPENCODE_API_TYPE: connection.apiType,
      OPENCODE_BASE_URL: connection.endpoint,
      OPENCODE_MODEL_CONTEXT_LIMIT: String(selected.context),
      OPENCODE_MODEL_OUTPUT_LIMIT: String(selected.output),
      OPENCODE_MODEL_INPUT_MODALITIES: selected.image ? 'text,image' : 'text',
    },
  };
}
