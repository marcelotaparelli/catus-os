// The only code that talks to ClickUp, and it can only GET: there is no method parameter,
// no body and no way to build another verb. Errors carry a code, never a URL, token or body.
const API = 'https://api.clickup.com/api/v2';
const MAX_BODY_BYTES = 32 * 1024 * 1024;
export type ClickUpErrorCode =
  | 'unauthorized'
  | 'not_found'
  | 'rate_limited'
  | 'upstream'
  | 'network'
  | 'timeout'
  | 'invalid_response'
  | 'too_large'
  | 'too_many_pages'
  | 'workspace_mismatch'
  | 'not_top_level'
  | 'hierarchy_mismatch'
  | 'too_many_tasks';
export class ClickUpError extends Error {
  constructor(
    readonly code: ClickUpErrorCode,
    readonly httpStatus: number | null = null,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super('ClickUp ' + code);
    this.name = 'ClickUpError';
  }
}
export interface ClickUpClientOptions {
  token: string;
  requestsPerMinute: number;
  fetch?: typeof globalThis.fetch;
  /** Tests only: the fake server. Production has no setting for this. */
  baseUrl?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
}
export type ClickUpClient = ReturnType<typeof createClickUpClient>;
const resetSeconds = (header: string | null, now: number) => {
  const value = Number(header);
  if (!header || !Number.isFinite(value) || value <= 0) return null;
  // Documented as a Unix timestamp without the unit: accept both.
  const at = value > 1e12 ? value : value * 1000;
  return Math.ceil((at - now) / 1000);
};
async function readLimited(res: Response) {
  if (Number(res.headers.get('content-length')) > MAX_BODY_BYTES)
    throw new ClickUpError('too_large', res.status);
  const reader = res.body?.getReader();
  if (!reader) throw new ClickUpError('invalid_response', res.status);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new ClickUpError('too_large', res.status);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString();
}
export function createClickUpClient(options: ClickUpClientOptions) {
  const send = options.fetch ?? globalThis.fetch,
    base = options.baseUrl ?? API,
    now = options.now ?? Date.now,
    sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms)),
    spacing = 60000 / options.requestsPerMinute;
  let calls = 0,
    nextAllowed = 0;
  async function pace() {
    const wait = nextAllowed - now();
    if (wait > 0) await sleep(wait);
    nextAllowed = Math.max(now(), nextAllowed) + spacing;
  }
  async function get(path: string, query: Record<string, string> = {}) {
    await pace();
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    calls++;
    let res: Response;
    try {
      res = await send(url, {
        method: 'GET',
        headers: { Authorization: options.token, Accept: 'application/json' },
        // A redirect could hand the token to another host.
        redirect: 'error',
        signal: AbortSignal.timeout(options.timeoutMs ?? 20000),
      });
    } catch (e) {
      throw new ClickUpError(
        (e as Error).name === 'TimeoutError' ? 'timeout' : 'network',
      );
    }
    const reset = resetSeconds(res.headers.get('x-ratelimit-reset'), now());
    if (res.status === 429)
      throw new ClickUpError(
        'rate_limited',
        429,
        Math.min(Math.max(reset ?? 60, 1), 3600),
      );
    if (res.status === 401 || res.status === 403)
      throw new ClickUpError('unauthorized', res.status);
    if (res.status === 404) throw new ClickUpError('not_found', 404);
    if (!res.ok) throw new ClickUpError('upstream', res.status);
    // Out of quota but not refused yet: wait for the window instead of provoking a 429.
    if (res.headers.get('x-ratelimit-remaining') === '0' && reset && reset > 0)
      nextAllowed = Math.max(nextAllowed, now() + Math.min(reset, 60) * 1000);
    let text: string;
    try {
      text = await readLimited(res);
    } catch (e) {
      if (e instanceof ClickUpError) throw e;
      throw new ClickUpError('network', res.status);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ClickUpError('invalid_response', res.status);
    }
  }
  return {
    calls: () => calls,
    getList: (listId: string) => get(`/list/${encodeURIComponent(listId)}`),
    /** One task and the subtasks Get Task returns with it; nothing of its siblings. */
    getTask: (taskId: string) =>
      get(`/task/${encodeURIComponent(taskId)}`, { include_subtasks: 'true' }),
    getTasksPage: (listId: string, page: number) =>
      get(`/list/${encodeURIComponent(listId)}/task`, {
        page: String(page),
        archived: 'false',
        subtasks: 'true',
        include_closed: 'true',
        // Without this, tasks whose home is another list are silently left out.
        include_timl: 'true',
        order_by: 'created',
      }),
  };
}
