import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Context } from '../auth/policy';
import { authorize, audit } from '../auth/policy';
import { HttpError } from '../errors';
import { InputError, text, uuid } from '../../shared/domain';
import {
  fields,
  integer,
  minor,
  one,
  today,
  object,
} from '../economics/validation';
import { inputHash } from '../economics/hash';
import { reserveCreation, completeCreation } from '../idempotency';
import type { DeliveryConfig } from './config';
import type { DeliverySettings, DeliveryResult } from '../../shared/delivery';
import { validPath, validThemePath } from '../../shared/delivery';
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const manager = (ctx: Context) => {
  if (!['manager', 'administrator'].includes(ctx.role))
    throw new HttpError(403, 'Gestor/admin necessário');
};
async function lock(db: PoolClient, org: string) {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,6))', [org]);
}
async function event(
  db: PoolClient,
  org: string,
  entity: string,
  job: string | null,
  actor: string,
  uid: string | null,
  action: string,
  data: unknown = {},
) {
  await db.query(
    'INSERT INTO delivery_events(id,organization_id,job_id,entity_id,actor_user_id,actor,action,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [
      crypto.randomUUID(),
      org,
      job,
      entity,
      uid,
      actor,
      action,
      JSON.stringify(data),
    ],
  );
}
async function humanEvent(
  ctx: Context,
  id: string,
  job: string | null,
  action: string,
  data: unknown = {},
) {
  await event(
    ctx.db,
    ctx.organizationId,
    id,
    job,
    ctx.name,
    ctx.userId,
    action,
    data,
  );
  await audit(ctx, 'delivery', id, action);
}
async function userAllowed(
  db: PoolClient,
  org: string,
  user: string,
  roles: string[],
) {
  return !!(
    await db.query(
      'SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1 AND m.user_id=$2 AND m.active AND u.active AND m.role=ANY($3::text[]) FOR SHARE OF m,u',
      [org, user, roles],
    )
  ).rowCount;
}
export function parseSettings(
  raw: unknown,
  config: DeliveryConfig,
): DeliverySettings {
  const b = object(raw);
  fields(b, [
    'repo_key',
    'repository',
    'base_branch',
    'base_sha',
    'allowed_paths',
    'task_types',
    'harness',
    'timeout_seconds',
    'max_input_tokens',
    'max_output_tokens',
    'input_micro_usd_per_million',
    'output_micro_usd_per_million',
    'job_budget_micro_usd',
    'daily_budget_micro_usd',
    'total_budget_micro_usd',
    'daily_job_limit',
    'concurrency',
    'attempt_limit',
    'min_margin_bps',
    'report_max_age_minutes',
    'max_diff_bytes',
  ]);
  const repo = config.repos.find(
    (r) =>
      r.key === b.repo_key &&
      r.repository === b.repository &&
      r.base_branch === b.base_branch &&
      r.base_sha === b.base_sha,
  );
  if (!repo)
    throw new HttpError(
      422,
      'Repositório/ref/SHA fora da allowlist operacional',
    );
  if (
    !Array.isArray(b.allowed_paths) ||
    !b.allowed_paths.length ||
    b.allowed_paths.length > 20 ||
    !b.allowed_paths.every(
      (p) => validThemePath(p) && repo.allowed_paths.includes(p),
    ) ||
    new Set(b.allowed_paths).size !== b.allowed_paths.length
  )
    throw new InputError('Caminhos fora da allowlist');
  if (
    !Array.isArray(b.task_types) ||
    b.task_types.length !== 1 ||
    b.task_types[0] !== 'nuvemshop-theme' ||
    b.attempt_limit !== 1 ||
    b.harness !== 'codex-sdk'
  )
    throw new InputError('M5 permite Nuvemshop, Codex SDK e uma tentativa');
  const s: DeliverySettings = {
    repo_key: repo.key,
    repository: repo.repository,
    base_branch: repo.base_branch,
    base_sha: repo.base_sha,
    allowed_paths: b.allowed_paths as string[],
    task_types: ['nuvemshop-theme'],
    harness: 'codex-sdk',
    timeout_seconds: integer(b.timeout_seconds, 'Timeout', 120, 5),
    max_input_tokens: integer(b.max_input_tokens, 'Input tokens', 32000, 1000),
    max_output_tokens: integer(b.max_output_tokens, 'Output tokens', 4096, 128),
    input_micro_usd_per_million: minor(b.input_micro_usd_per_million),
    output_micro_usd_per_million: minor(b.output_micro_usd_per_million),
    job_budget_micro_usd: minor(b.job_budget_micro_usd),
    daily_budget_micro_usd: minor(b.daily_budget_micro_usd),
    total_budget_micro_usd: minor(b.total_budget_micro_usd),
    daily_job_limit: integer(b.daily_job_limit, 'Jobs/dia', 20, 1),
    concurrency: integer(b.concurrency, 'Concorrência', 2, 1),
    attempt_limit: 1,
    min_margin_bps: integer(b.min_margin_bps, 'Margem mínima', 10000),
    report_max_age_minutes: integer(
      b.report_max_age_minutes,
      'Frescor',
      240,
      1,
    ),
    max_diff_bytes: integer(b.max_diff_bytes, 'Diff bytes', 8192, 128),
  };
  if (
    BigInt(s.input_micro_usd_per_million) <= 0n ||
    BigInt(s.output_micro_usd_per_million) <= 0n ||
    BigInt(s.job_budget_micro_usd) <= 0n ||
    BigInt(s.job_budget_micro_usd) > 10000000n ||
    BigInt(s.daily_budget_micro_usd) > 100000000n ||
    BigInt(s.total_budget_micro_usd) > 1000000000n ||
    BigInt(s.daily_budget_micro_usd) < BigInt(s.job_budget_micro_usd) ||
    BigInt(s.total_budget_micro_usd) < BigInt(s.daily_budget_micro_usd)
  )
    throw new InputError('Preços/tetos USD explícitos inválidos');
  const maximum =
    (BigInt(s.max_input_tokens) * BigInt(s.input_micro_usd_per_million) +
      BigInt(s.max_output_tokens) * BigInt(s.output_micro_usd_per_million) +
      999999n) /
    1000000n;
  if (maximum > BigInt(s.job_budget_micro_usd))
    throw new InputError('Orçamento/job menor que teto de tokens/preços');
  return s;
}
async function row(db: PoolClient, org: string, id: string) {
  const q = (
    await db.query(
      'SELECT r.*,i.project_id,p.client_id FROM requests r JOIN interactions i ON i.id=r.interaction_id AND i.organization_id=r.organization_id JOIN projects p ON p.id=i.project_id AND p.organization_id=i.organization_id WHERE r.id=$1 AND r.organization_id=$2',
      [uuid(id), org],
    )
  ).rows[0];
  if (!q) throw new HttpError(404, 'Demanda não encontrada');
  return q;
}
export async function eligibility(
  db: PoolClient,
  org: string,
  id: string,
  config: DeliveryConfig,
  existingJob = false,
) {
  const req = await row(db, org, id),
    reasons: string[] = [];
  const policy = (
    await db.query(
      'SELECT * FROM delivery_policies WHERE organization_id=$1 AND project_id=$2',
      [org, req.project_id],
    )
  ).rows[0];
  const spec = (
    await db.query(
      'SELECT * FROM delivery_specs WHERE organization_id=$1 AND request_id=$2 ORDER BY revision DESC LIMIT 1',
      [org, id],
    )
  ).rows[0];
  if (!policy?.enabled) reasons.push('Política de execução desativada/ausente');
  if (!config.available) reasons.push(config.reason);
  const settings = policy?.settings as DeliverySettings | undefined;
  if (settings) {
    try {
      parseSettings(settings, config);
    } catch {
      reasons.push('Repo/ref/política fora da allowlist atual');
    }
  }
  if (!spec) reasons.push('Especificação/aceite Nuvemshop ausentes');
  if (req.status !== 'ready') reasons.push('Estado operacional deve ser ready');
  if (
    !req.owner_user_id ||
    !(await userAllowed(db, org, req.owner_user_id, [
      'developer',
      'po',
      'manager',
      'administrator',
    ]))
  )
    reasons.push('Responsável ativo obrigatório');
  if (
    spec &&
    !(await userAllowed(db, org, spec.created_by, [
      'po',
      'manager',
      'administrator',
    ]))
  )
    reasons.push('Preparador sem autorização atual');
  if (
    policy &&
    !(await userAllowed(db, org, policy.approved_by, [
      'manager',
      'administrator',
    ]))
  )
    reasons.push('Autorizador da política foi revogado');
  const coverage = (
    await db.query(
      `SELECT s.id scope_id,s.number,c.id contract_id,c.version contract_version FROM scope_items si JOIN scope_versions s ON s.id=si.scope_id AND s.organization_id=si.organization_id JOIN contracts c ON c.id=s.contract_id AND c.organization_id=s.organization_id WHERE si.id=$1 AND si.organization_id=$2 AND s.project_id=$3 AND s.state='approved' AND c.state='active' AND (now() AT TIME ZONE 'UTC')::date BETWEEN c.valid_from AND c.valid_until`,
      [req.scope_item_id, org, req.project_id],
    )
  ).rows[0];
  if (!coverage)
    reasons.push('Cobertura M3 atual/contrato vigente obrigatórios');
  const report = (
    await db.query(
      'SELECT er.*,a.actor_user_id report_approver FROM economic_reports er LEFT JOIN delivery_report_approvals a ON a.report_id=er.id AND a.organization_id=er.organization_id WHERE er.organization_id=$1 AND er.project_id=$2 ORDER BY er.created_at DESC,er.id DESC LIMIT 1',
      [org, req.project_id],
    )
  ).rows[0];
  if (!report || !report.report_approver)
    reasons.push('Última observação M4 exige aprovação independente');
  if (report) {
    const result = report.result as Record<string, unknown>,
      inputs = report.inputs;
    if (
      settings &&
      Date.now() - new Date(report.created_at).getTime() >
        settings.report_max_age_minutes * 60000
    )
      reasons.push('Observação econômica vencida');
    if (
      (report.as_of instanceof Date
        ? report.as_of.toISOString().slice(0, 10)
        : String(report.as_of).slice(0, 10)) !== today() ||
      String(result.period_from) > today() ||
      String(result.period_until) < today()
    )
      reasons.push('Competência/corte M4 não é atual');
    if (
      !Array.isArray(result.projection_missing) ||
      result.projection_missing.length ||
      !Array.isArray(result.actual_missing) ||
      result.actual_missing.length ||
      result.projected_margin_bps === null
    )
      reasons.push('Base econômica incompleta');
    if (
      settings &&
      result.projected_margin_bps !== null &&
      BigInt(String(result.projected_margin_bps)) <
        BigInt(settings.min_margin_bps)
    )
      reasons.push('Margem abaixo do limiar autorizado');
    if (
      result.remaining_minutes === null ||
      result.capacity_minutes === null ||
      Number(result.remaining_minutes) > Number(result.capacity_minutes) ||
      Number(result.remaining_minutes) <= 0
    )
      reasons.push('Capacidade/restante insuficientes');
    if (
      coverage &&
      (inputs.commercial_basis?.scope_id !== coverage.scope_id ||
        inputs.commercial_basis?.contract_id !== coverage.contract_id)
    )
      reasons.push('M4 não cobre a versão M3 atual');
    if (
      !inputs.estimates?.some(
        (e: { payload: { request_id: string; user_id: string } }) =>
          e.payload.request_id === id &&
          e.payload.user_id === req.owner_user_id,
      )
    )
      reasons.push('Estimativa aprovada para demanda/responsável obrigatória');
    const changed = (
      await db.query(
        `SELECT EXISTS(SELECT 1 FROM economic_decisions d JOIN economic_records r ON r.id=d.record_id AND r.organization_id=d.organization_id WHERE r.organization_id=$1 AND (r.project_id=$2 OR r.project_id IS NULL) AND d.decided_at>$3) OR EXISTS(SELECT 1 FROM time_entries t WHERE t.organization_id=$1 AND t.project_id=$2 AND t.created_at>$3) OR EXISTS(SELECT 1 FROM time_events e JOIN time_entries t ON t.id=e.entry_id AND t.organization_id=e.organization_id WHERE t.organization_id=$1 AND t.project_id=$2 AND e.created_at>$3) changed`,
        [org, req.project_id, report.created_at],
      )
    ).rows[0].changed;
    if (changed) reasons.push('Bases/horas M4 mudaram após observação');
    if (
      report.report_approver &&
      !(await userAllowed(db, org, report.report_approver, [
        'manager',
        'administrator',
      ]))
    )
      reasons.push('Aprovador econômico revogado');
  }
  if (policy && settings) {
    const totals = (
      await db.query('SELECT * FROM delivery_totals WHERE policy_id=$1', [
        policy.id,
      ])
    ).rows[0];
    const day = (
      await db.query(
        "SELECT * FROM delivery_days WHERE policy_id=$1 AND day=(now() AT TIME ZONE 'UTC')::date",
        [policy.id],
      )
    ).rows[0];
    const own =
      spec &&
      (
        await db.query(
          "SELECT 1 FROM delivery_jobs WHERE spec_id=$1 AND state IN ('queued','claimed','running','awaiting_review')",
          [spec.id],
        )
      ).rowCount;
    const reserve =
      existingJob || own ? 0n : BigInt(settings.job_budget_micro_usd);
    if (
      BigInt(totals?.reserved_micro_usd ?? 0) +
        BigInt(totals?.spent_micro_usd ?? 0) +
        reserve >
      BigInt(settings.total_budget_micro_usd)
    )
      reasons.push('Orçamento total indisponível');
    if (
      BigInt(day?.reserved_micro_usd ?? 0) +
        BigInt(day?.spent_micro_usd ?? 0) +
        reserve >
        BigInt(settings.daily_budget_micro_usd) ||
      (!existingJob &&
        !own &&
        Number(day?.jobs ?? 0) >= settings.daily_job_limit)
    )
      reasons.push('Orçamento/limite diário indisponível');
  }
  const basisHash = inputHash({
    request_version: req.version,
    owner: req.owner_user_id,
    scope: coverage ?? null,
    report_id: report?.id ?? null,
    report_hash: report?.input_hash ?? null,
    policy_version: policy?.version ?? null,
    spec_id: spec?.id ?? null,
  });
  return {
    request: req,
    policy,
    spec,
    report,
    settings,
    eligible: reasons.length === 0,
    reasons,
    basis_hash: basisHash,
  };
}
async function settle(
  db: PoolClient,
  j: Record<string, unknown>,
  amount: bigint,
) {
  if (j.consumed_micro_usd !== null && j.consumed_micro_usd !== undefined)
    return;
  await db.query(
    'UPDATE delivery_totals SET reserved_micro_usd=reserved_micro_usd-$2,spent_micro_usd=spent_micro_usd+$3 WHERE policy_id=$1',
    [j.policy_id, j.reserved_micro_usd, amount.toString()],
  );
  await db.query(
    'UPDATE delivery_days SET reserved_micro_usd=reserved_micro_usd-$3,spent_micro_usd=spent_micro_usd+$4 WHERE policy_id=$1 AND day=$2',
    [j.policy_id, j.budget_day, j.reserved_micro_usd, amount.toString()],
  );
  await db.query('UPDATE delivery_jobs SET consumed_micro_usd=$2 WHERE id=$1', [
    j.id,
    amount.toString(),
  ]);
}
async function stopJob(
  db: PoolClient,
  j: Record<string, unknown>,
  state: string,
  code: string,
) {
  await settle(
    db,
    j,
    j.state === 'queued' ? 0n : BigInt(String(j.reserved_micro_usd)),
  );
  await db.query(
    'UPDATE delivery_jobs SET state=$2,failure_code=$3,lease_hash=NULL,lease_until=NULL,updated_at=now() WHERE id=$1',
    [j.id, state, code],
  );
  await event(
    db,
    String(j.organization_id),
    String(j.id),
    String(j.id),
    'delivery-broker',
    null,
    state,
    { reason: code },
  );
}
export async function reconcileDelivery(ctx: Context, config: DeliveryConfig) {
  await lock(ctx.db, ctx.organizationId);
  const active = (
    await ctx.db.query(
      "SELECT * FROM delivery_jobs WHERE organization_id=$1 AND state IN ('queued','claimed','running') FOR UPDATE",
      [ctx.organizationId],
    )
  ).rows;
  for (const j of active) {
    const e = await eligibility(
      ctx.db,
      ctx.organizationId,
      j.request_id,
      config,
      true,
    );
    if (!e.eligible || e.basis_hash !== j.basis_hash)
      await stopJob(ctx.db, j, 'blocked', 'authorization_or_basis_changed');
    else if (j.lease_until && new Date(j.lease_until).getTime() < Date.now())
      await stopJob(ctx.db, j, 'failed', 'runner_interrupted_requires_review');
  }
  if (!config.available) return;
  const candidates = (
    await ctx.db.query(
      "SELECT r.id FROM requests r JOIN interactions i ON i.id=r.interaction_id AND i.organization_id=r.organization_id JOIN delivery_policies p ON p.project_id=i.project_id AND p.organization_id=i.organization_id WHERE r.organization_id=$1 AND r.status='ready' AND p.enabled ORDER BY r.created_at,r.id LIMIT 100",
      [ctx.organizationId],
    )
  ).rows;
  for (const r of candidates) {
    const e = await eligibility(ctx.db, ctx.organizationId, r.id, config);
    if (!e.eligible || !e.settings || !e.spec) continue;
    if (
      (
        await ctx.db.query(
          'SELECT 1 FROM delivery_jobs WHERE spec_id=$1 OR (request_id=$2 AND organization_id=$3 AND state=ANY($4::text[]))',
          [
            e.spec.id,
            r.id,
            ctx.organizationId,
            ['queued', 'claimed', 'running', 'awaiting_review'],
          ],
        )
      ).rowCount
    )
      continue;
    const s = e.settings,
      p = e.policy;
    await ctx.db.query(
      'INSERT INTO delivery_totals(policy_id) VALUES($1) ON CONFLICT DO NOTHING',
      [p.id],
    );
    await ctx.db.query(
      "INSERT INTO delivery_days(policy_id,day) VALUES($1,(now() AT TIME ZONE 'UTC')::date) ON CONFLICT DO NOTHING",
      [p.id],
    );
    const totals = (
        await ctx.db.query(
          'SELECT * FROM delivery_totals WHERE policy_id=$1 FOR UPDATE',
          [p.id],
        )
      ).rows[0],
      daily = (
        await ctx.db.query(
          "SELECT * FROM delivery_days WHERE policy_id=$1 AND day=(now() AT TIME ZONE 'UTC')::date FOR UPDATE",
          [p.id],
        )
      ).rows[0],
      reserve = BigInt(s.job_budget_micro_usd);
    if (
      BigInt(totals.reserved_micro_usd) +
        BigInt(totals.spent_micro_usd) +
        reserve >
        BigInt(s.total_budget_micro_usd) ||
      BigInt(daily.reserved_micro_usd) +
        BigInt(daily.spent_micro_usd) +
        reserve >
        BigInt(s.daily_budget_micro_usd) ||
      daily.jobs >= s.daily_job_limit
    )
      continue;
    const id = crypto.randomUUID();
    await ctx.db.query(
      "INSERT INTO delivery_jobs(id,organization_id,project_id,request_id,spec_id,policy_id,policy_version,report_id,basis_hash,snapshot,state,budget_day,reserved_micro_usd) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'queued',(now() AT TIME ZONE 'UTC')::date,$11)",
      [
        id,
        ctx.organizationId,
        e.request.project_id,
        r.id,
        e.spec.id,
        p.id,
        p.version,
        e.report.id,
        e.basis_hash,
        JSON.stringify({
          settings: s,
          specification: e.spec.specification,
          acceptance: e.spec.acceptance,
          source_interaction_id: e.request.interaction_id,
          source_proposal_id: e.request.origin_proposal_id,
        }),
        reserve.toString(),
      ],
    );
    await ctx.db.query(
      'UPDATE delivery_totals SET reserved_micro_usd=reserved_micro_usd+$2 WHERE policy_id=$1',
      [p.id, reserve.toString()],
    );
    await ctx.db.query(
      "UPDATE delivery_days SET reserved_micro_usd=reserved_micro_usd+$2,jobs=jobs+1 WHERE policy_id=$1 AND day=(now() AT TIME ZONE 'UTC')::date",
      [p.id, reserve.toString()],
    );
    await humanEvent(ctx, id, id, 'automatically_queued', {
      request_id: r.id,
      policy_id: p.id,
      policy_version: p.version,
      report_id: e.report.id,
    });
  }
}
export async function deliveryView(ctx: Context, config: DeliveryConfig) {
  authorize(ctx, 'read');
  const policies = (
      await ctx.db.query(
        'SELECT * FROM delivery_policies WHERE organization_id=$1',
        [ctx.organizationId],
      )
    ).rows,
    specs = (
      await ctx.db.query(
        'SELECT * FROM delivery_specs WHERE organization_id=$1 ORDER BY created_at DESC',
        [ctx.organizationId],
      )
    ).rows;
  const requests = (
    await ctx.db.query(
      'SELECT DISTINCT request_id id FROM delivery_specs WHERE organization_id=$1 LIMIT 100',
      [ctx.organizationId],
    )
  ).rows;
  const eligible = [];
  for (const r of requests) {
    const e = await eligibility(ctx.db, ctx.organizationId, r.id, config);
    eligible.push({
      request_id: r.id,
      eligible: e.eligible,
      reasons: e.reasons,
    });
  }
  const jobs = (
    await ctx.db.query(
      'SELECT * FROM delivery_jobs WHERE organization_id=$1 ORDER BY created_at DESC,id LIMIT 100',
      [ctx.organizationId],
    )
  ).rows;
  const privateRole = ['manager', 'administrator'].includes(ctx.role);
  return {
    capability: { available: config.available, reason: config.reason },
    repositories: config.repos.map((r) => ({
      key: r.key,
      repository: r.repository,
      base_branch: r.base_branch,
      base_sha: r.base_sha,
      allowed_paths: r.allowed_paths,
    })),
    policies: policies.map((p) =>
      privateRole
        ? p
        : {
            id: p.id,
            project_id: p.project_id,
            enabled: p.enabled,
            version: p.version,
            settings: {
              repo_key: p.settings.repo_key,
              repository: p.settings.repository,
              base_branch: p.settings.base_branch,
              base_sha: p.settings.base_sha,
              allowed_paths: p.settings.allowed_paths,
            },
          },
    ),
    specs,
    eligibility: eligible,
    jobs: jobs.map((j) =>
      privateRole
        ? { ...j, lease_hash: undefined }
        : {
            id: j.id,
            request_id: j.request_id,
            state: j.state,
            failure_code: j.failure_code,
            result: j.result,
            created_at: j.created_at,
            report_id: j.report_id,
          },
    ),
    events: (
      await ctx.db.query(
        'SELECT id,action,actor,actor_user_id,created_at,data FROM delivery_events WHERE organization_id=$1 ORDER BY created_at DESC,id LIMIT 200',
        [ctx.organizationId],
      )
    ).rows,
  };
}
export async function humanDelivery(
  ctx: Context,
  path: string,
  method: string,
  b: Record<string, unknown> | undefined,
  key: string | null,
  config: DeliveryConfig,
): Promise<Response | undefined> {
  if (method === 'GET' && path === '/api/delivery')
    return Response.json(await deliveryView(ctx, config));
  if (method !== 'POST' || !b) return undefined;
  const review = /^\/api\/delivery\/jobs\/([^/]+)\/(review|cancel)$/.exec(path),
    reportApprove = /^\/api\/delivery\/reports\/([^/]+)\/approve$/.exec(path);
  if (
    !['/api/delivery/policies', '/api/delivery/specs'].includes(path) &&
    !review &&
    !reportApprove
  )
    return undefined;
  if (path.endsWith('/specs')) authorize(ctx, 'create');
  else manager(ctx);
  await lock(ctx.db, ctx.organizationId);
  const prior = await reserveCreation(ctx, path, key, b);
  if (prior) return Response.json(prior.body, { status: prior.status });
  let result: unknown;
  if (path.endsWith('/policies')) {
    fields(b, ['project_id', 'version', 'enabled', 'settings', 'reason']);
    const projectId = uuid(b.project_id);
    if (typeof b.enabled !== 'boolean')
      throw new InputError('Ativação explícita obrigatória');
    text(b.reason, 'Autorização e política', 2000);
    if (
      !(
        await ctx.db.query(
          'SELECT 1 FROM projects WHERE id=$1 AND organization_id=$2',
          [projectId, ctx.organizationId],
        )
      ).rowCount
    )
      throw new HttpError(404, 'Projeto não encontrado');
    const existing = (
      await ctx.db.query(
        'SELECT * FROM delivery_policies WHERE project_id=$1 AND organization_id=$2 FOR UPDATE',
        [projectId, ctx.organizationId],
      )
    ).rows[0];
    if ((existing?.version ?? 0) !== b.version)
      throw new HttpError(409, 'Política mudou; recarregue');
    const settings = parseSettings(b.settings, config),
      id = existing?.id ?? crypto.randomUUID();
    const policy = (
      await ctx.db.query(
        'INSERT INTO delivery_policies(id,organization_id,project_id,enabled,settings,approved_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(project_id,organization_id) DO UPDATE SET enabled=EXCLUDED.enabled,settings=EXCLUDED.settings,approved_by=EXCLUDED.approved_by,approved_at=now(),version=delivery_policies.version+1 RETURNING *',
        [
          id,
          ctx.organizationId,
          projectId,
          b.enabled,
          JSON.stringify(settings),
          ctx.userId,
        ],
      )
    ).rows[0];
    await humanEvent(
      ctx,
      id,
      null,
      b.enabled ? 'policy_activated' : 'policy_disabled',
      { before: existing ?? null, after: policy, reason: b.reason },
    );
    result = policy;
  } else if (path.endsWith('/specs')) {
    fields(b, [
      'request_id',
      'revision',
      'task_type',
      'specification',
      'acceptance',
      'data_scope',
    ]);
    const r = await row(ctx.db, ctx.organizationId, uuid(b.request_id));
    if (b.task_type !== 'nuvemshop-theme' || b.data_scope !== 'synthetic')
      throw new InputError('Somente tarefas Nuvemshop sintéticas autorizadas');
    const old = (
      await ctx.db.query(
        'SELECT * FROM delivery_specs WHERE request_id=$1 AND organization_id=$2 ORDER BY revision DESC LIMIT 1',
        [r.id, ctx.organizationId],
      )
    ).rows[0];
    if ((old?.revision ?? 0) !== b.revision)
      throw new HttpError(409, 'Especificação mudou; recarregue');
    if (
      (
        await ctx.db.query(
          "SELECT 1 FROM delivery_jobs WHERE request_id=$1 AND organization_id=$2 AND state IN ('queued','claimed','running','awaiting_review')",
          [r.id, ctx.organizationId],
        )
      ).rowCount
    )
      throw new HttpError(409, 'Cancele/revise o job ativo antes de corrigir');
    const spec = text(b.specification, 'Especificação', 6000),
      accept = text(b.acceptance, 'Critérios de aceite', 3000);
    if (spec.length < 30 || accept.length < 15)
      throw new InputError('Especificação/aceite insuficientes');
    result = (
      await ctx.db.query(
        'INSERT INTO delivery_specs(id,organization_id,request_id,revision,task_type,specification,acceptance,data_scope,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
        [
          crypto.randomUUID(),
          ctx.organizationId,
          r.id,
          (old?.revision ?? 0) + 1,
          b.task_type,
          spec,
          accept,
          b.data_scope,
          ctx.userId,
        ],
      )
    ).rows[0];
    await humanEvent(ctx, r.id, null, 'specification_prepared', {
      revision: (old?.revision ?? 0) + 1,
    });
  } else if (reportApprove) {
    fields(b, ['reason']);
    const id = uuid(reportApprove[1]),
      report = (
        await ctx.db.query(
          'SELECT * FROM economic_reports WHERE id=$1 AND organization_id=$2',
          [id, ctx.organizationId],
        )
      ).rows[0];
    if (!report) throw new HttpError(404, 'Observação não encontrada');
    if (report.created_by === ctx.userId)
      throw new HttpError(
        403,
        'Autor não pode aprovar sua própria observação para execução',
      );
    if (
      report.result.projection_missing.length ||
      report.result.actual_missing.length
    )
      throw new HttpError(409, 'Observação incompleta não autoriza execução');
    await ctx.db.query(
      'INSERT INTO delivery_report_approvals(report_id,organization_id,actor_user_id,reason) VALUES($1,$2,$3,$4)',
      [
        id,
        ctx.organizationId,
        ctx.userId,
        text(b.reason, 'Justificativa', 2000),
      ],
    );
    await humanEvent(ctx, id, null, 'economic_observation_approved', {
      report_id: id,
    });
    result = { id, approved: true };
  } else if (review) {
    fields(b, review[2] === 'cancel' ? ['reason'] : ['decision', 'reason']);
    const id = uuid(review[1]),
      job = (
        await ctx.db.query(
          'SELECT * FROM delivery_jobs WHERE id=$1 AND organization_id=$2 FOR UPDATE',
          [id, ctx.organizationId],
        )
      ).rows[0];
    if (!job) throw new HttpError(404, 'Job não encontrado');
    text(b.reason, 'Revisão humana', 2000);
    if (review[2] === 'cancel') {
      if (
        !['queued', 'claimed', 'running', 'awaiting_review'].includes(job.state)
      )
        throw new HttpError(409, 'Job não pode ser cancelado');
      await stopJob(ctx.db, job, 'cancelled', 'human_cancelled');
      result = { id, state: 'cancelled' };
    } else {
      if (job.state !== 'awaiting_review')
        throw new HttpError(409, 'Resultado não está aguardando revisão');
      const decision = one(b.decision, [
        'accepted',
        'rejected',
        'correction_requested',
      ]);
      if (decision === 'accepted') {
        const e = await eligibility(
          ctx.db,
          ctx.organizationId,
          job.request_id,
          config,
          true,
        );
        if (!e.eligible || e.basis_hash !== job.basis_hash)
          throw new HttpError(409, 'Bases/política mudaram; aceite bloqueado');
      }
      await ctx.db.query(
        'INSERT INTO delivery_reviews(job_id,organization_id,actor_user_id,decision,reason) VALUES($1,$2,$3,$4,$5)',
        [id, ctx.organizationId, ctx.userId, decision, b.reason],
      );
      const state =
        decision === 'accepted'
          ? 'completed'
          : decision === 'rejected'
            ? 'cancelled'
            : 'blocked';
      await ctx.db.query(
        'UPDATE delivery_jobs SET state=$2,updated_at=now() WHERE id=$1',
        [id, state],
      );
      result = { id, state };
    }
    await humanEvent(
      ctx,
      id,
      id,
      review[2] === 'cancel' ? 'human_cancelled' : 'human_reviewed',
      b,
    );
  }
  const response = Response.json(result, { status: 200 });
  await completeCreation(ctx, path, key!, response);
  return response;
}
export async function runnerRoute(
  db: PoolClient,
  request: Request,
  body: Record<string, unknown>,
  config: DeliveryConfig,
  identified?: (runner: {
    organization_id: string;
    project_id: string;
  }) => void,
): Promise<Response> {
  const token = request.headers
    .get('authorization')
    ?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  if (!token) throw new HttpError(401, 'Runner não autorizado');
  const runner = (
    await db.query(
      'SELECT * FROM delivery_runners WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()',
      [digest(token)],
    )
  ).rows[0];
  if (!runner) throw new HttpError(401, 'Runner não autorizado');
  identified?.(runner);
  await lock(db, runner.organization_id);
  const path = new URL(request.url).pathname,
    match =
      /^\/api\/delivery-runner\/jobs\/([^/]+)\/(start|heartbeat|finish)$/.exec(
        path,
      );
  // Runner may only see its own project; it never receives M3/M4 values, tokens, user management or DB credentials.
  if (path === '/api/delivery-runner/claim') {
    fields(body, []);
    const queued = (
      await db.query(
        "SELECT * FROM delivery_jobs WHERE organization_id=$1 AND project_id=$2 AND state IN ('queued','claimed','running') ORDER BY created_at,id FOR UPDATE SKIP LOCKED",
        [runner.organization_id, runner.project_id],
      )
    ).rows;
    for (const j of queued) {
      if (j.lease_until && new Date(j.lease_until).getTime() < Date.now())
        await stopJob(db, j, 'failed', 'runner_interrupted_requires_review');
    }
    for (const j of queued.filter((j) => j.state === 'queued')) {
      const e = await eligibility(
        db,
        runner.organization_id,
        j.request_id,
        config,
      );
      if (
        !e.eligible ||
        j.basis_hash !== e.basis_hash ||
        String(
          j.budget_day instanceof Date
            ? j.budget_day.toISOString().slice(0, 10)
            : j.budget_day,
        ) !== today()
      ) {
        await stopJob(db, j, 'blocked', 'claim_revalidation_failed');
        continue;
      }
      const running = (
        await db.query(
          "SELECT count(*) n FROM delivery_jobs WHERE policy_id=$1 AND state IN ('claimed','running')",
          [j.policy_id],
        )
      ).rows[0];
      if (Number(running.n) >= e.settings!.concurrency)
        return Response.json({ task: null });
      const lease = randomBytes(32).toString('base64url');
      await db.query(
        "UPDATE delivery_jobs SET state='claimed',attempt=1,runner_id=$2,lease_hash=$3,lease_until=now()+($4::int*interval '1 second'),updated_at=now() WHERE id=$1",
        [j.id, runner.id, digest(lease), e.settings!.timeout_seconds + 120],
      );
      await event(
        db,
        runner.organization_id,
        j.id,
        j.id,
        'delivery-runner',
        null,
        'claimed',
      );
      return Response.json({
        task: {
          job_id: j.id,
          spec_id: j.spec_id,
          request_id: j.request_id,
          policy_version: j.policy_version,
          repo_key: e.settings!.repo_key,
          repository: e.settings!.repository,
          base_branch: e.settings!.base_branch,
          base_sha: e.settings!.base_sha,
          allowed_paths: e.settings!.allowed_paths,
          specification: j.snapshot.specification,
          acceptance: j.snapshot.acceptance,
          settings: e.settings,
          basis_hash: j.basis_hash,
        },
        lease,
      });
    }
    return Response.json({ task: null });
  }
  if (!match) throw new HttpError(404, 'Rota de runner não encontrada');
  fields(
    body,
    match[2] === 'finish' ? ['lease', 'result', 'failure_code'] : ['lease'],
  );
  const id = uuid(match[1]);
  const job = (
    await db.query(
      'SELECT * FROM delivery_jobs WHERE id=$1 AND organization_id=$2 AND project_id=$3 AND runner_id=$4 FOR UPDATE',
      [id, runner.organization_id, runner.project_id, runner.id],
    )
  ).rows[0];
  if (!job) throw new HttpError(404, 'Job não encontrado');
  if (
    typeof body.lease !== 'string' ||
    !job.lease_hash ||
    !timingSafeEqual(
      Buffer.from(digest(body.lease), 'hex'),
      Buffer.from(job.lease_hash, 'hex'),
    ) ||
    !['claimed', 'running'].includes(job.state) ||
    new Date(job.lease_until).getTime() < Date.now()
  )
    throw new HttpError(409, 'Lease inválido/expirado; não reexecutar');
  const e = await eligibility(
    db,
    runner.organization_id,
    job.request_id,
    config,
    true,
  );
  if (!e.eligible || job.basis_hash !== e.basis_hash) {
    await stopJob(db, job, 'blocked', 'runtime_revalidation_failed');
    return Response.json({ cancel: true });
  }
  if (match[2] === 'heartbeat') return Response.json({ cancel: false });
  if (match[2] === 'start') {
    if (job.state !== 'claimed') throw new HttpError(409, 'Job já começou');
    await db.query(
      "UPDATE delivery_jobs SET state='running',updated_at=now() WHERE id=$1",
      [id],
    );
    await event(
      db,
      runner.organization_id,
      id,
      id,
      'delivery-runner',
      null,
      'running',
    );
    return Response.json({ cancel: false });
  }
  if (job.state !== 'running') throw new HttpError(409, 'Job não executando');
  if (body.failure_code) {
    const code = one(body.failure_code, [
      'unavailable',
      'timeout',
      'sandbox_failure',
      'invalid_changes',
      'tests_failed',
      'cancelled',
      'runner_failure',
    ]);
    await stopJob(db, job, 'failed', code);
    return Response.json({ state: 'failed' });
  }
  const r = validateResult(
    body.result,
    job.snapshot.settings,
    config.fixture === true,
  );
  let charged = BigInt(job.reserved_micro_usd);
  if (r.input_tokens !== null && r.output_tokens !== null) {
    charged =
      (BigInt(r.input_tokens) *
        BigInt(e.settings!.input_micro_usd_per_million) +
        BigInt(r.output_tokens) *
          BigInt(e.settings!.output_micro_usd_per_million) +
        999999n) /
      1000000n;
    if (charged > BigInt(job.reserved_micro_usd))
      throw new InputError('Uso excedeu reserva: revisão obrigatória');
  }
  await settle(db, job, charged);
  await db.query(
    "UPDATE delivery_jobs SET state='awaiting_review',result=$2,lease_hash=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",
    [id, JSON.stringify(r)],
  );
  await event(
    db,
    runner.organization_id,
    id,
    id,
    'delivery-runner',
    null,
    'awaiting_review',
    {
      harness: r.harness,
      llm_verified: r.llm_verified,
      cleanup_confirmed: r.cleanup_confirmed,
    },
  );
  return Response.json({ state: 'awaiting_review' });
}
export function validateResult(
  raw: unknown,
  s: DeliverySettings,
  fixtureAllowed = false,
): DeliveryResult {
  const r = object(raw);
  fields(r, [
    'harness',
    'llm_verified',
    'base_sha',
    'patch',
    'files',
    'tests',
    'input_tokens',
    'output_tokens',
    'latency_ms',
    'cleanup_confirmed',
  ]);
  if (
    r.base_sha !== s.base_sha ||
    !Array.isArray(r.files) ||
    !r.files.length ||
    !r.files.every((p) => validPath(p) && s.allowed_paths.includes(p)) ||
    !Array.isArray(r.tests) ||
    !r.tests.length ||
    r.cleanup_confirmed !== true
  )
    throw new InputError('Evidência/caminhos/limpeza inválidos');
  const harness = one(r.harness, ['codex-sdk', 'test-fixture']);
  if (
    (harness === 'test-fixture' && !fixtureAllowed) ||
    r.llm_verified !== (harness === 'codex-sdk')
  )
    throw new InputError('Harness não autorizado');
  const patch = text(r.patch, 'Patch', s.max_diff_bytes);
  if (
    Buffer.byteLength(patch) > s.max_diff_bytes ||
    /sk-[A-Za-z0-9_-]{12,}|BEGIN .*PRIVATE KEY|Bearer [A-Za-z0-9_-]{20,}/.test(
      patch,
    )
  )
    throw new InputError('Patch excessivo/sensível');
  const diffPaths = [
    ...patch.matchAll(
      /^diff --git a\/([a-zA-Z0-9_./-]+) b\/([a-zA-Z0-9_./-]+)$/gm,
    ),
  ].map((m) => {
    if (m[1] !== m[2] || !validPath(m[1]) || !s.allowed_paths.includes(m[1]))
      throw new InputError('Patch fora da allowlist');
    return m[1];
  });
  if (
    !diffPaths.length ||
    diffPaths.length !== r.files.length ||
    !r.files.every((p) => diffPaths.includes(String(p))) ||
    /^(?:rename |copy |Binary files|GIT binary)/m.test(patch)
  )
    throw new InputError('Patch não corresponde aos arquivos declarados');
  const tests = r.tests.map((t) => {
    const a = object(t);
    fields(a, ['argv', 'exit_code', 'log']);
    if (
      !Array.isArray(a.argv) ||
      a.argv.length > 10 ||
      !a.argv.every((x) => typeof x === 'string' && x.length < 200) ||
      a.argv[0] !== 'node' ||
      a.argv[1] !== '--test' ||
      !a.argv.slice(2).every(validPath) ||
      a.exit_code !== 0
    )
      throw new InputError('Testes devem passar com comandos permitidos');
    if (
      /sk-[A-Za-z0-9_-]{12,}|BEGIN .*PRIVATE KEY|Bearer [A-Za-z0-9_-]{20,}|postgres(?:ql)?:\/\//i.test(
        String(a.log),
      )
    )
      throw new InputError('Log sensível recusado');
    return {
      argv: a.argv as string[],
      exit_code: 0,
      log: text(a.log, 'Log sanitizado', 1500),
    };
  });
  const input =
      r.input_tokens === null
        ? null
        : integer(r.input_tokens, 'Input tokens', s.max_input_tokens),
    output =
      r.output_tokens === null
        ? null
        : integer(r.output_tokens, 'Output tokens', s.max_output_tokens);
  return {
    harness,
    llm_verified: r.llm_verified as boolean,
    base_sha: s.base_sha,
    patch,
    files: r.files as string[],
    tests,
    input_tokens: input,
    output_tokens: output,
    latency_ms: integer(r.latency_ms, 'Latência', 240000),
    cleanup_confirmed: true,
  };
}
