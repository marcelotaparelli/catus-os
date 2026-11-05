// OFF unless explicitly enabled and fully configured. The token reaches only the worker
// process: the web launcher strips it, so the web side knows just which tenant may see data.
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const workspacePattern = /^\d{1,20}$/;
type Env = Record<string, string | undefined>;
export type WorkerConfig =
  | { enabled: false; reason: 'off' | 'missing_token' | 'invalid_config' }
  | {
      enabled: true;
      token: string;
      organizationId: string;
      workspaceId: string;
      requestsPerMinute: number;
      syncMinutes: number;
    };
function bounded(value: string | undefined, fallback: number, max: number) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= max ? n : null;
}
/** Which organization may read the integration; undefined means the feature does not exist. */
export function clickupOrganization(env: Env = process.env) {
  if (env.CLICKUP_ENABLED !== 'true') return undefined;
  const id = env.CLICKUP_ORGANIZATION_ID ?? '';
  return uuidPattern.test(id) ? id.toLowerCase() : undefined;
}
export function clickupWorkerConfig(env: Env = process.env): WorkerConfig {
  if (env.CLICKUP_ENABLED !== 'true') return { enabled: false, reason: 'off' };
  const token = env.CLICKUP_API_TOKEN?.trim();
  if (!token) return { enabled: false, reason: 'missing_token' };
  const organizationId = clickupOrganization(env),
    workspaceId = env.CLICKUP_WORKSPACE_ID ?? '',
    // 100/min is ClickUp's lowest plan limit, shared by every use of the token.
    requestsPerMinute = bounded(env.CLICKUP_REQUESTS_PER_MINUTE, 60, 1000),
    syncMinutes = bounded(env.CLICKUP_SYNC_MINUTES, 15, 1440);
  if (
    !organizationId ||
    !workspacePattern.test(workspaceId) ||
    !requestsPerMinute ||
    !syncMinutes
  )
    return { enabled: false, reason: 'invalid_config' };
  return {
    enabled: true,
    token,
    organizationId,
    workspaceId,
    requestsPerMinute,
    syncMinutes,
  };
}
