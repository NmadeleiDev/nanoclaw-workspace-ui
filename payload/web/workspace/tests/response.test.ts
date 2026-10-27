import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceConnectionError, workspaceRequest, workspaceResponse } from '../src/response';
const json = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
it.each([404, 502, 503, 504])('recognizes a non-JSON HTTP %i as a connection failure without claiming the host is down', async status => {
  const error = await workspaceResponse(new Response('proxy error', { status })).catch(e => e);
  expect(error).toBeInstanceOf(WorkspaceConnectionError);
  expect(error.retryable).toBe(true);
  expect(error.message).not.toContain('NanoClaw is unavailable');
});
it('rejects an HTML success response and malformed JSON', async () => {
  await expect(workspaceResponse(new Response('<html>Proxy error</html>', { headers: { 'Content-Type': 'text/html' } }))).rejects.toThrow('unexpected response');
  await expect(workspaceResponse(json('502 Bad Gateway', 502))).rejects.toThrow('Could not read the workspace response (HTTP 502)');
});
it('preserves structured server errors and successful response values', async () => {
  await expect(workspaceResponse(json('{"error":"Owner access has been revoked."}',403))).rejects.toThrow('Owner access has been revoked.');
  await expect(workspaceResponse(json('{"ok":true}'))).resolves.toEqual({ ok: true });
  await expect(workspaceResponse(json('[1,2]'))).resolves.toEqual([1,2]);
});
it('recovers a GET after a proxy 404 and a dropped connection', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response('404 page not found', {status:404}))
    .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    .mockResolvedValueOnce(json('{"ok":true}'));
  const result = workspaceRequest('/api/bootstrap', {}, fetcher);
  await vi.runAllTimersAsync();
  await expect(result).resolves.toEqual({ok:true});
  expect(fetcher).toHaveBeenCalledTimes(3);
});
it('bounds GET retries and records only method, path, and status', async () => {
  vi.useFakeTimers();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('private proxy body', {status:502}));
  const result = workspaceRequest('/api/bootstrap?token=private#secret', {}, fetcher).catch(e=>e);
  await vi.runAllTimersAsync();
  expect(await result).toBeInstanceOf(WorkspaceConnectionError);
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(warn).toHaveBeenCalledExactlyOnceWith('Workspace request failed', {method:'GET',path:'/api/bootstrap',status:502});
});
it.each(['POST', 'PATCH', 'DELETE'])('never retries %s after an uncertain response', async method => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('Bad gateway', {status:502}));
  await expect(workspaceRequest('/api/sessions/demo/messages', {method}, fetcher)).rejects.toThrow('action may have completed');
  expect(fetcher).toHaveBeenCalledOnce();
});
it.each([403,404,503])('never retries structured application errors (HTTP %i)', async status => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json('{"error":"Application rejection"}',status));
  await expect(workspaceRequest('/api/bootstrap', {}, fetcher)).rejects.toThrow('Application rejection');
  expect(fetcher).toHaveBeenCalledOnce();
});
it('cancels a pending backoff without another request or connection warning', async () => {
  vi.useFakeTimers();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const controller = new AbortController();
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('Not found', {status:404}));
  const result = workspaceRequest('/api/bootstrap', {signal:controller.signal}, fetcher).catch(e=>e);
  await vi.advanceTimersByTimeAsync(1);
  controller.abort();
  expect((await result).name).toBe('AbortError');
  await vi.runAllTimersAsync();
  expect(fetcher).toHaveBeenCalledOnce();
  expect(warn).not.toHaveBeenCalled();
});
