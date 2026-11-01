export interface DeliverySettings {
  repo_key: string;
  repository: string;
  base_branch: string;
  base_sha: string;
  allowed_paths: string[];
  task_types: 'nuvemshop-theme'[];
  harness: 'codex-sdk' | 'responses-api';
  timeout_seconds: number;
  max_input_tokens: number;
  max_output_tokens: number;
  input_micro_usd_per_million: string;
  output_micro_usd_per_million: string;
  job_budget_micro_usd: string;
  daily_budget_micro_usd: string;
  total_budget_micro_usd: string;
  daily_job_limit: number;
  concurrency: number;
  attempt_limit: 1;
  min_margin_bps: number;
  report_max_age_minutes: number;
  max_diff_bytes: number;
}
export interface DeliveryTask {
  job_id: string;
  spec_id: string;
  request_id: string;
  policy_version: number;
  repo_key: string;
  repository: string;
  base_branch: string;
  base_sha: string;
  allowed_paths: string[];
  specification: string;
  acceptance: string;
  settings: DeliverySettings;
  basis_hash: string;
}
export interface DeliveryResult {
  harness: 'codex-sdk' | 'responses-api' | 'test-fixture';
  llm_verified: boolean;
  base_sha: string;
  patch: string;
  files: string[];
  tests: { argv: string[]; exit_code: number; log: string }[];
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number;
  cleanup_confirmed: boolean;
}
export interface DeliveryView {
  capability: { available: boolean; reason: string };
  policies: {
    id: string;
    project_id: string;
    enabled: boolean;
    version: number;
    settings: DeliverySettings;
  }[];
  specs: {
    id: string;
    request_id: string;
    revision: number;
    specification: string;
    acceptance: string;
    task_type: string;
  }[];
  jobs: {
    id: string;
    request_id: string;
    state: string;
    failure_code: string | null;
    result: DeliveryResult | null;
    reserved_micro_usd?: string;
    consumed_micro_usd?: string | null;
    report_id: string;
    created_at: string;
  }[];
  eligibility: { request_id: string; eligible: boolean; reasons: string[] }[];
  events: {
    id: string;
    action: string;
    actor: string;
    actor_user_id: string | null;
    created_at: string;
    data: unknown;
  }[];
}
export const forbiddenPath = (p: string) =>
  p.startsWith('-') ||
  p.startsWith('/') ||
  p.includes('\\') ||
  p.includes('..') ||
  !/^[a-zA-Z0-9_./-]+$/.test(p) ||
  p
    .split('/')
    .some(
      (s) =>
        !s ||
        s.startsWith('.') ||
        /^(node_modules|vendor|secrets|private|credentials)$/i.test(s),
    ) ||
  /\.(pem|key|p12|pfx|env)$/i.test(p) ||
  /^(package(-lock)?\.json|.*\.lock)$/i.test(p);
export function validPath(p: unknown): p is string {
  return typeof p === 'string' && p.length <= 180 && !forbiddenPath(p);
}

export function validThemePath(p: unknown): p is string {
  return (
    validPath(p) &&
    /^(?:(?:templates|snipplets)\/[a-zA-Z0-9_/-]+\.tpl|static\/(?:css\/[a-zA-Z0-9_/-]+\.css|js\/[a-zA-Z0-9_/-]+\.js))$/.test(
      p,
    )
  );
}
