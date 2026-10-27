import { expect, it } from 'vitest';
import { workspaceResponse } from '../src/response';
const json = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
it.each([[502, '502 Bad Gateway'], [404, '404 page not found']] as const)('reports HTTP %i without parsing a plain-text error page as JSON', async (status, body) => {
  await expect(workspaceResponse(new Response(body, { status }))).rejects.toThrow(`NanoClaw is unavailable (HTTP ${status})`);
});
it('rejects an HTML success response and malformed JSON with workspace-specific errors', async () => {
  await expect(workspaceResponse(new Response('<html>Proxy error</html>', { headers: { 'Content-Type': 'text/html' } }))).rejects.toThrow('unexpected response');
  await expect(workspaceResponse(json('502 Bad Gateway', 502))).rejects.toThrow('Could not read the workspace response (HTTP 502)');
});
it('preserves structured server errors and successful response values', async () => {
  await expect(workspaceResponse(json('{"error":"Owner access has been revoked."}',403))).rejects.toThrow('Owner access has been revoked.');
  await expect(workspaceResponse(json('{"ok":true}'))).resolves.toEqual({ ok: true });
  await expect(workspaceResponse(json('[1,2]'))).resolves.toEqual([1,2]);
});
