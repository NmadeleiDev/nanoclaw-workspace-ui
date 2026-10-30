import { expect, it } from 'vitest';
import { approvalDeadline, parseApprovalComment, LIVE_CONNECTION_WINDOW_MS } from './deadlines.js';
it('gives durable decisions ten minutes without extending an earlier provider deadline', () => {
  const start = '2026-10-28T00:00:00.000Z';
  expect(approvalDeadline(start)).toBe('2026-10-28T00:10:00.000Z');
  expect(approvalDeadline(start, '2026-10-28T00:00:30.000Z')).toBe('2026-10-28T00:00:30.000Z');
  expect(approvalDeadline(start, '2026-10-28T01:00:00.000Z')).toBe('2026-10-28T00:10:00.000Z');
  expect(LIVE_CONNECTION_WINDOW_MS).toBe(120000);
  expect(() => approvalDeadline(start, 'invalid')).toThrow();
});
it('validates optional decision comments and counts Unicode characters', () => {
  expect(parseApprovalComment(undefined)).toBeUndefined();
  expect(parseApprovalComment('  ')).toBeUndefined();
  expect(parseApprovalComment(' Please use a different port. ')).toBe('Please use a different port.');
  expect(parseApprovalComment('😀'.repeat(2000))).toHaveLength(4000);
  expect(() => parseApprovalComment('x'.repeat(2001))).toThrow();
  expect(() => parseApprovalComment({ text: 'not a string' })).toThrow();
});
