/** Latest context footprint, never accumulated billing usage. Shared with runner. */
export interface ContextUsage {
  usedTokens: number;
  contextWindow: number | null;
  model: string | null;
  estimated: boolean;
}
export function contextUsage(used: unknown, window: unknown, model?: unknown, estimated = true): ContextUsage | null {
  if (typeof used !== 'number' || !Number.isSafeInteger(used) || used < 0) return null;
  return {
    usedTokens: used,
    contextWindow: typeof window === 'number' && Number.isSafeInteger(window) && window > 0 ? window : null,
    model: typeof model === 'string' ? model.slice(0, 200) : null,
    estimated,
  };
}
export function parseContextUsage(value: Record<string, unknown>): ContextUsage | null {
  return contextUsage(value.usedTokens, value.contextWindow, value.model, value.estimated !== false);
}
