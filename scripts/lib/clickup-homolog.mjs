// Pure helpers of the assisted ClickUp homologation (scripts/clickup-homolog.ts).
import { isAbsolute, relative } from 'node:path';

export const MARKER = '.local/clickup-homolog.json';
export const DEFAULT_ORGANIZATION = '00000000-0000-4000-8000-000000000001';
/** Only these keys are ever written by the flow; secrets are never among them. */
export const MANAGED_KEYS = [
  'CLICKUP_ENABLED',
  'CLICKUP_ORGANIZATION_ID',
  'CLICKUP_WORKSPACE_ID',
  'CLICKUP_REQUESTS_PER_MINUTE',
  'CLICKUP_API_TOKEN_FILE',
];

/** Replaces or appends KEY=value lines; every other line, comments included, stays. */
export function upsertEnv(text, values) {
  for (const key of Object.keys(values))
    if (!MANAGED_KEYS.includes(key))
      throw new Error(`Chave não gerenciada: ${key}`);
  const seen = new Set();
  const lines = text.split('\n').map((line) => {
    const m = /^([A-Z_][A-Z0-9_]*)=/.exec(line);
    if (!m || !(m[1] in values)) return line;
    seen.add(m[1]);
    return `${m[1]}=${values[m[1]]}`;
  });
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const [key, value] of Object.entries(values))
    if (!seen.has(key)) lines.push(`${key}=${value}`);
  return lines.join('\n') + '\n';
}
export const isInside = (dir, path) => {
  const r = relative(dir, path);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};

/**
 * What the worker account may and may not do. `expected: true` must hold, `false` must not.
 * Economics, contracts, demands, people and the mappings decided by partners stay out of reach.
 */
export const WORKER_PRIVILEGES = [
  ['economic_records', 'SELECT', false],
  ['economic_reports', 'SELECT', false],
  ['time_entries', 'SELECT', false],
  ['contracts', 'SELECT', false],
  ['scope_items', 'SELECT', false],
  ['requests', 'SELECT', false],
  ['users', 'SELECT', false],
  ['memberships', 'SELECT', false],
  ['sessions', 'SELECT', false],
  ['audit_events', 'SELECT', false],
  ['clickup_status_mappings', 'SELECT', false],
  ['clickup_list_status_mappings', 'SELECT', false],
  ['clickup_tasks', 'DELETE', false],
  ['clickup_list_tasks', 'DELETE', false],
  ['clickup_sync_runs', 'DELETE', false],
  ['clickup_project_links', 'INSERT', false],
  ['clickup_project_links', 'DELETE', false],
  ['clickup_project_links', 'SELECT', true],
  ['clickup_tasks', 'INSERT', true],
  ['clickup_tasks', 'UPDATE', true],
  ['clickup_list_tasks', 'INSERT', true],
  ['clickup_sync_runs', 'INSERT', true],
];

/** One line per check; `status`: ok, pending (needs the owner) or fail. */
export function formatReport(items) {
  const label = { ok: 'OK      ', pending: 'PENDENTE', fail: 'FALHA   ' };
  return items
    .map(
      (i) =>
        `${label[i.status]}  ${i.title}${i.detail ? `\n          ${i.detail}` : ''}`,
    )
    .join('\n');
}
