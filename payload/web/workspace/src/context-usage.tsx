export interface ContextUsageValue {
  usedTokens: number;
  contextWindow: number | null;
  model: string | null;
  estimated: boolean;
  updatedAt?: string;
}
export function contextUsageDisplay(usage: ContextUsageValue | undefined, selectedModel?: string) {
  const modelMatches =
    !selectedModel ||
    !usage?.model ||
    selectedModel === usage.model ||
    (['sonnet', 'opus', 'haiku'].includes(selectedModel) && usage.model.includes(selectedModel));
  if (!usage || !modelMatches)
    return {
      label: 'Context —',
      title: 'Context usage will appear after the backend reports it for this model.',
      percent: null,
      tokens: null,
    };
  if (!usage.contextWindow)
    return {
      label: 'Context —',
      title: `${usage.usedTokens.toLocaleString()} tokens reported; context-window size unavailable.`,
      percent: null,
      tokens: null,
    };
  const percent = (usage.usedTokens / usage.contextWindow) * 100;
  const shown = percent > 0 && percent < 1 ? percent.toFixed(1) : Math.round(percent).toString();
  return {
    label: `Context ${usage.estimated ? '~' : ''}${shown}%`,
    title: `${usage.usedTokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens · Latest context ${usage.estimated ? 'estimate' : 'usage'}, not cumulative token spending.`,
    percent,
    tokens: `(${usage.usedTokens.toLocaleString()}/${usage.contextWindow.toLocaleString()})`,
  };
}
export function ContextUsageIndicator({ usage, model }: { usage?: ContextUsageValue; model?: string }) {
  const display = contextUsageDisplay(usage, model);
  return (
    <span className="composer-context-usage" title={display.title} aria-label={`${display.label}. ${display.title}`}>
      {display.percent !== null && (
        <span className="context-usage-meter" aria-hidden="true">
          <i style={{ width: `${Math.min(100, Math.max(0, display.percent))}%` }} />
        </span>
      )}
      {display.label}
      {display.tokens && <span className="context-token-count" aria-hidden="true">{display.tokens}</span>}
    </span>
  );
}
