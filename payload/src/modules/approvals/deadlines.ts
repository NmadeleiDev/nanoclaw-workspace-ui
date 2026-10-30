/** Human decision windows are distinct from held connection timeouts. */
export const APPROVAL_DECISION_WINDOW_MS = 10 * 60_000;
export const LIVE_CONNECTION_WINDOW_MS = 2 * 60_000;
export const APPROVAL_HISTORY_RETENTION_MS = 90 * 24 * 60 * 60_000;

export function approvalDeadline(createdAt: string, earlierDeadline?: string): string {
  const created = Date.parse(createdAt);
  const supplied = earlierDeadline === undefined ? Infinity : Date.parse(earlierDeadline);
  if (!Number.isFinite(created) || Number.isNaN(supplied)) throw new Error('Invalid approval deadline');
  return new Date(Math.min(created + APPROVAL_DECISION_WINDOW_MS, supplied)).toISOString();
}

export function parseApprovalComment(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error('Approval comment must be text');
  const comment = value.trim();
  if (Array.from(comment).length > 2000) throw new Error('Keep approval comments within 2,000 characters');
  return comment || undefined;
}
