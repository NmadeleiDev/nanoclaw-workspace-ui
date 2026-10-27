/** A failed connection is distinct from a structured application rejection. */
export class WorkspaceConnectionError extends Error {
  constructor(message: string, readonly status: number | null = null, readonly retryable = false) {
    super(message);
    this.name = 'WorkspaceConnectionError';
  }
}
export async function workspaceResponse<T>(response: Response): Promise<T> {
  const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json' && !type.endsWith('+json')) {
    if (!response.ok) {
      const retryable = [404, 502, 503, 504].includes(response.status);
      throw new WorkspaceConnectionError(
        response.status === 404
          ? 'The workspace address could not be reached (HTTP 404).'
          : `The workspace connection returned HTTP ${response.status}. Try again shortly.`,
        response.status, retryable,
      );
    }
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
function pause(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason ?? new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}
/** Retry reads only: a lost response must never cause a duplicate message or action. */
export async function workspaceRequest<T>(url: string, init: RequestInit = {}, fetcher: typeof fetch = fetch): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  for (let attempt = 0; ; attempt++) {
    try {
      init.signal?.throwIfAborted();
      let response: Response;
      try { response = await fetcher(url, init); }
      catch (error) {
        if (init.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
        if (!(error instanceof TypeError)) throw error;
        throw new WorkspaceConnectionError('The workspace connection was interrupted. Check your connection to the host.', null, true);
      }
      return await workspaceResponse<T>(response);
    } catch (error) {
      if (init.signal?.aborted) throw init.signal.reason;
      if (error instanceof WorkspaceConnectionError) {
        if (method === 'GET' && error.retryable && attempt < 2) {
          await pause(attempt === 0 ? 350 : 1000, init.signal);
          continue;
        }
        // No response bodies, query strings, credentials or message contents in diagnostics.
        console.warn('Workspace request failed', { method, path: url.split(/[?#]/)[0], status: error.status });
        if (method !== 'GET' && method !== 'HEAD')
          throw new WorkspaceConnectionError(`${error.message} The action may have completed; check its result before trying again.`, error.status);
      }
      throw error;
    }
  }
}
