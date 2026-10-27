import { describe, expect, it } from 'vitest';
import { navigationKey, navigationUrl, resolveNavigation } from '../src/navigation';

const origin = 'https://workspace.test/';
const data = {
  agents: [{ id: 'assistant' }, { id: 'engineer' }],
  projects: [{ id: 'atlas' }],
  sessions: [{ id: 'chat /one', agentId: 'engineer', projectId: 'atlas' }],
};
const overview = { agentId: 'assistant', projectId: null, sessionId: null };
const remembered = { agentId: 'engineer', projectId: 'atlas', sessionId: 'chat /one' };

describe('workspace URL navigation', () => {
  it('round-trips conversation IDs and resolves their actual agent and project', () => {
    const href = navigationUrl(origin, remembered);
    expect(new URL(href).searchParams.get('session')).toBe('chat /one');
    expect(resolveNavigation(href, data)).toEqual(remembered);
    expect(resolveNavigation(origin + '?agent=assistant&project=wrong&session=chat%20%2Fone', data)).toEqual(remembered);
  });
  it('restores project and agent overviews without reopening a remembered conversation', () => {
    expect(resolveNavigation(origin + '?agent=engineer&project=atlas', data, remembered))
      .toEqual({ agentId: 'engineer', projectId: 'atlas', sessionId: null });
    expect(resolveNavigation(origin + '?agent=assistant', data, remembered)).toEqual(overview);
  });
  it('uses remembered selection only when the URL has no navigation parameters', () => {
    expect(resolveNavigation(origin, data, remembered)).toEqual(remembered);
    expect(resolveNavigation(origin, data)).toEqual(overview);
  });
  it('handles missing and removed IDs without opening an unrelated remembered chat', () => {
    expect(resolveNavigation(origin + '?session=deleted', data, remembered)).toEqual(overview);
    expect(resolveNavigation(origin + '?agent=removed&project=gone', data)).toEqual(overview);
    expect(resolveNavigation(origin, { agents: [], projects: [], sessions: [] }, remembered))
      .toEqual({ agentId: '', projectId: null, sessionId: null });
  });
  it('preserves notification and pairing parameters while replacing only navigation', () => {
    const href = navigationUrl(origin + '?activity=event&project=old&session=old#pair=token', remembered);
    const url = new URL(href);
    expect(url.searchParams.get('activity')).toBe('event');
    expect(url.hash).toBe('#pair=token');
    expect(url.searchParams.has('project')).toBe(false);
    expect(navigationUrl(href, overview)).toBe(origin + '?activity=event&agent=assistant#pair=token');
  });
  it('does not create a history entry when conversation metadata changes', () => {
    expect(navigationKey(remembered)).toBe(navigationKey({ ...remembered, projectId: null }));
    expect(navigationKey(overview)).not.toBe(navigationKey({ ...overview, projectId: 'atlas' }));
  });
});
