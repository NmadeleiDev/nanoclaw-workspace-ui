/** Keep transport failures distinct from valid JSON application errors. */
export async function workspaceResponse<T>(response: Response): Promise<T> {
  const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json' && !type.endsWith('+json')) {
    if (!response.ok)
      throw new Error(`NanoClaw is unavailable (HTTP ${response.status}). Check the workspace host and try again.`);
    throw new Error('The workspace returned an unexpected response. Reload the app or check the host.');
  }
  let value: unknown;
  try { value = await response.json(); }
  catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new Error(`Could not read the workspace response (HTTP ${response.status}). Reload the app or check the host.`);
  }
  if (!response.ok) {
    const error = value && typeof value === 'object' && 'error' in value ? value.error : null;
    throw new Error(typeof error === 'string' && error ? error : `Workspace request failed (HTTP ${response.status}).`);
  }
  return value as T;
}
