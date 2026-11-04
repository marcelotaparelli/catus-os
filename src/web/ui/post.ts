type Api = <T>(
  path: string,
  method?: string,
  body?: unknown,
  key?: string,
) => Promise<T>;
/** POST whose retry of the same body reuses its Idempotency-Key, so nothing is written twice. */
export function idempotentPost(api: Api) {
  const attempts = new Map<string, { json: string; key: string }>();
  return async <T>(path: string, body: unknown): Promise<T> => {
    const json = JSON.stringify(body);
    let a = attempts.get(path);
    if (!a || a.json !== json) {
      a = { json, key: crypto.randomUUID() };
      attempts.set(path, a);
    }
    const result = await api<T>(path, 'POST', body, a.key);
    attempts.delete(path);
    return result;
  };
}
