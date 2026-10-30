import { contextUsage, type ContextUsage } from '../context-usage.generated.js';
export function openCodeContextUsage(info: Record<string, unknown>, limit?: number): ContextUsage | null {
  if (info.role !== 'assistant' || !info.tokens || typeof info.tokens !== 'object') return null;
  const tokens = info.tokens as Record<string, unknown>;
  const cache = tokens.cache as Record<string, unknown> | undefined;
  if (typeof tokens.input !== 'number' || tokens.input < 0) return null;
  const parts = [tokens.input, tokens.output, tokens.reasoning, cache?.read, cache?.write];
  if (
    parts.some(
      (value) => value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0),
    )
  )
    return null;
  const used = parts.reduce<number>((sum, value) => sum + (typeof value === 'number' ? value : 0), 0);
  // OpenCode emits an empty initial assistant record before the API responds.
  if (!used) return null;
  return contextUsage(used, limit, `${info.providerID}/${info.modelID}`);
}
export async function claudeContextUsage(query: {
  getContextUsage?: (options: {
    detail: 'summary';
  }) => Promise<{ totalTokens: number; rawMaxTokens: number; model: string }>;
}): Promise<ContextUsage | null> {
  if (!query.getContextUsage) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      query.getContextUsage({ detail: 'summary' }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 1500);
      }),
    ]);
    return value ? contextUsage(value.totalTokens, value.rawMaxTokens, value.model) : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
