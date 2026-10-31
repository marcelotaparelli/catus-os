import { createHash } from 'node:crypto';
import type { Context } from '../auth/policy';
import { authorize, audit } from '../auth/policy';
import { HttpError } from '../errors';
import { InputError, text, uuid } from '../../shared/domain';
import { createRequest } from './requests';
import type { ExtractionProvider, ModelConfig } from '../ai/provider';
import { reservation } from '../ai/provider';
import { findDuplicates } from '../ai/duplicates';
import { reserveCreation, completeCreation } from '../idempotency';
export function requireAiRole(ctx: Context) {
  authorize(ctx, 'create');
}
export async function capability(
  ctx: Context,
  provider: ExtractionProvider | undefined,
) {
  requireAiRole(ctx);
  const policy =
    (
      await ctx.db.query('SELECT * FROM ai_policies WHERE organization_id=$1', [
        ctx.organizationId,
      ])
    ).rows[0] ?? null;
  return {
    available: !!provider && !!policy?.enabled,
    reason: !provider
      ? 'LLM indisponível: faltam credenciais/configuração/política do ambiente'
      : !policy?.enabled
        ? 'Política de IA da organização não habilitada'
        : 'Extração disponível; confirmação humana obrigatória',
    ...(provider ? { model: provider.config.model } : {}),
    policy,
  };
}
export async function setAiPolicy(ctx: Context, body: Record<string, unknown>) {
  authorize(ctx, 'admin');
  if (
    typeof body.enabled !== 'boolean' ||
    !['synthetic', 'authorized_client'].includes(String(body.data_scope))
  )
    throw new InputError('Política inválida');
  for (const k of [
    'daily_budget_micro_usd',
    'per_job_budget_micro_usd',
    'daily_job_limit',
  ]) {
    const max =
      k === 'daily_job_limit'
        ? 100
        : k === 'daily_budget_micro_usd'
          ? 100000000
          : 10000000;
    if (
      !Number.isSafeInteger(body[k]) ||
      Number(body[k]) < 1 ||
      Number(body[k]) > max
    )
      throw new InputError('Limite de política inválido');
  }
  const policyReference = text(
    body.policy_reference,
    'Referência da política',
    500,
  );
  await ctx.db.query(
    `INSERT INTO ai_policies(organization_id,enabled,policy_reference,data_scope,daily_budget_micro_usd,per_job_budget_micro_usd,daily_job_limit,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(organization_id) DO UPDATE SET enabled=excluded.enabled,policy_reference=excluded.policy_reference,data_scope=excluded.data_scope,daily_budget_micro_usd=excluded.daily_budget_micro_usd,per_job_budget_micro_usd=excluded.per_job_budget_micro_usd,daily_job_limit=excluded.daily_job_limit,updated_by=excluded.updated_by,updated_at=now()`,
    [
      ctx.organizationId,
      body.enabled,
      policyReference,
      body.data_scope,
      body.daily_budget_micro_usd,
      body.per_job_budget_micro_usd,
      body.daily_job_limit,
      ctx.userId,
    ],
  );
  await audit(ctx, 'ai_policy', ctx.organizationId, 'updated');
  return { status: 'updated' };
}
export async function enqueueExtraction(
  ctx: Context,
  body: Record<string, unknown>,
  key: string | null,
  provider: ExtractionProvider | undefined,
) {
  requireAiRole(ctx);
  const interaction = uuid(body.interaction_id);
  if (!key) throw new HttpError(400, 'Idempotency-Key obrigatório');
  uuid(key);
  if (
    body.confirm_external_processing !== true ||
    !['synthetic', 'authorized_client'].includes(String(body.data_scope))
  )
    throw new InputError('Confirme classificação e envio conforme política');
  const hash = createHash('sha256')
    .update(JSON.stringify([interaction, body.data_scope, true]))
    .digest('hex');
  await ctx.db.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1,241902))',
    [ctx.organizationId],
  );
  const prior = (
    await ctx.db.query(
      'SELECT id,request_hash,state FROM extraction_jobs WHERE organization_id=$1 AND requested_by=$2 AND idempotency_key=$3',
      [ctx.organizationId, ctx.userId, key],
    )
  ).rows[0];
  if (prior) {
    if (prior.request_hash !== hash)
      throw new HttpError(409, 'Chave usada em outra extração');
    return { id: prior.id, state: prior.state };
  }
  if (!provider)
    throw new HttpError(
      503,
      'Inferência indisponível; nenhuma chamada foi realizada',
    );
  const source = (
    await ctx.db.query(
      'SELECT summary,project_id FROM interactions WHERE id=$1 AND organization_id=$2',
      [interaction, ctx.organizationId],
    )
  ).rows[0];
  if (!source) throw new HttpError(404, 'Atendimento não encontrado');
  const policy = (
    await ctx.db.query('SELECT * FROM ai_policies WHERE organization_id=$1', [
      ctx.organizationId,
    ])
  ).rows[0];
  if (!policy?.enabled)
    throw new HttpError(403, 'Política de IA não habilitada');
  if (
    body.data_scope === 'authorized_client' &&
    (policy.data_scope !== 'authorized_client' ||
      !provider.config.clientDataAllowed)
  )
    throw new HttpError(403, 'Envio de dados de clientes não autorizado');
  const budget = reservation(provider.config);
  if (budget > Number(policy.per_job_budget_micro_usd))
    throw new HttpError(409, 'Reserva excede orçamento por extração');
  if (
    (
      await ctx.db.query(
        "SELECT 1 FROM extraction_jobs WHERE interaction_id=$1 AND organization_id=$2 AND state IN ('queued','running')",
        [interaction, ctx.organizationId],
      )
    ).rowCount
  )
    throw new HttpError(409, 'Já existe extração ativa neste atendimento');
  const day = (
    await ctx.db.query("SELECT (now() AT TIME ZONE 'UTC')::date::text AS day")
  ).rows[0].day;
  await ctx.db.query(
    'INSERT INTO ai_budget_days(organization_id,day) VALUES($1,$2) ON CONFLICT DO NOTHING',
    [ctx.organizationId, day],
  );
  const charged = await ctx.db.query(
    'UPDATE ai_budget_days SET reserved_micro_usd=reserved_micro_usd+$3,jobs=jobs+1 WHERE organization_id=$1 AND day=$2 AND reserved_micro_usd+spent_micro_usd+$3<=$4 AND jobs<$5 RETURNING day',
    [
      ctx.organizationId,
      day,
      budget,
      policy.daily_budget_micro_usd,
      policy.daily_job_limit,
    ],
  );
  if (!charged.rowCount)
    throw new HttpError(409, 'Limite diário de IA atingido');
  const id = crypto.randomUUID();
  await ctx.db.query(
    'INSERT INTO extraction_jobs(id,organization_id,interaction_id,project_id,requested_by,idempotency_key,request_hash,source_text,source_hash,data_scope,policy_reference,provider_config,budget_day,reserved_micro_usd) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
    [
      id,
      ctx.organizationId,
      interaction,
      source.project_id,
      ctx.userId,
      key,
      hash,
      source.summary,
      createHash('sha256').update(source.summary).digest('hex'),
      body.data_scope,
      policy.policy_reference,
      provider.config,
      day,
      budget,
    ],
  );
  await audit(
    ctx,
    'extraction',
    id,
    'queued:human-confirmed-external-processing',
  );
  return { id, state: 'queued' };
}
export async function listExtractions(ctx: Context) {
  requireAiRole(ctx);
  return (
    await ctx.db.query(
      'SELECT id,interaction_id,state,created_at,failure_code,input_tokens,output_tokens,estimated_cost_micro_usd,latency_ms,provider_config FROM extraction_jobs WHERE organization_id=$1 ORDER BY created_at DESC,id LIMIT 100',
      [ctx.organizationId],
    )
  ).rows;
}
export async function getExtraction(ctx: Context, id: string) {
  requireAiRole(ctx);
  uuid(id);
  const job = (
    await ctx.db.query(
      'SELECT * FROM extraction_jobs WHERE id=$1 AND organization_id=$2',
      [id, ctx.organizationId],
    )
  ).rows[0];
  if (!job) throw new HttpError(404, 'Extração não encontrada');
  const proposals = (
    await ctx.db.query(
      'SELECT * FROM ai_proposals WHERE extraction_id=$1 AND organization_id=$2 ORDER BY id',
      [id, ctx.organizationId],
    )
  ).rows;
  for (const p of proposals)
    if (p.state === 'proposed')
      p.duplicates = await findDuplicates(
        ctx.db,
        ctx.organizationId,
        job.project_id,
        p.title,
        p.id,
      );
  const reviews = (
    await ctx.db.query(
      'SELECT r.* FROM proposal_reviews r JOIN ai_proposals p ON p.id=r.proposal_id AND p.organization_id=r.organization_id WHERE p.extraction_id=$1 AND r.organization_id=$2 ORDER BY r.created_at,r.id',
      [id, ctx.organizationId],
    )
  ).rows;
  return { ...job, proposals, reviews };
}
export async function reviewProposal(
  ctx: Context,
  id: string,
  body: Record<string, unknown>,
) {
  requireAiRole(ctx);
  uuid(id);
  if (
    !Number.isSafeInteger(body.version) ||
    !['edited', 'rejected'].includes(String(body.action))
  )
    throw new InputError('Revisão inválida');
  const before = (
    await ctx.db.query(
      'SELECT * FROM ai_proposals WHERE id=$1 AND organization_id=$2 FOR UPDATE',
      [id, ctx.organizationId],
    )
  ).rows[0];
  if (!before) throw new HttpError(404, 'Proposta não encontrada');
  if (before.version !== body.version || before.state !== 'proposed')
    throw new HttpError(409, 'Proposta já revisada; atualize');
  let after;
  if (body.action === 'rejected')
    after = (
      await ctx.db.query(
        "UPDATE ai_proposals SET state='rejected',version=version+1 WHERE id=$1 AND organization_id=$2 RETURNING *",
        [id, ctx.organizationId],
      )
    ).rows[0];
  else {
    if (
      !Array.isArray(body.acceptance_criteria) ||
      body.acceptance_criteria.length < 1 ||
      body.acceptance_criteria.length > 8
    )
      throw new InputError('Critérios inválidos');
    const criteria = body.acceptance_criteria.map((c) =>
      text(c, 'Critério', 2000),
    );
    // Edited wording is explicitly human-authored. Original LLM result and evidence remain immutable in job.
    after = (
      await ctx.db.query(
        'UPDATE ai_proposals SET title=$3,description=$4,acceptance_criteria=$5,version=version+1 WHERE id=$1 AND organization_id=$2 RETURNING *',
        [
          id,
          ctx.organizationId,
          text(body.title, 'Título'),
          text(body.description, 'Descrição', 4000),
          JSON.stringify(
            criteria.map((t) => ({ text: t, evidence: before.evidence })),
          ),
        ],
      )
    ).rows[0];
  }
  await ctx.db.query(
    'INSERT INTO proposal_reviews(id,organization_id,proposal_id,actor_user_id,action,before_snapshot,after_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [
      crypto.randomUUID(),
      ctx.organizationId,
      id,
      ctx.userId,
      body.action,
      before,
      after,
    ],
  );
  await audit(ctx, 'proposal', id, String(body.action));
  return after;
}
export async function approveProposals(
  ctx: Context,
  jobId: string,
  body: Record<string, unknown>,
  key: string | null,
) {
  requireAiRole(ctx);
  uuid(jobId);
  if (
    body.confirm_human_review !== true ||
    !Array.isArray(body.proposals) ||
    body.proposals.length < 1 ||
    body.proposals.length > 8
  )
    throw new InputError('Confirmação humana e propostas obrigatórias');
  const path = '/api/extractions/' + jobId + '/approve';
  const cached = await reserveCreation(ctx, path, key, body);
  if (cached) return cached.body;
  const job = (
    await ctx.db.query(
      "SELECT * FROM extraction_jobs WHERE id=$1 AND organization_id=$2 AND state='succeeded'",
      [jobId, ctx.organizationId],
    )
  ).rows[0];
  if (!job) throw new HttpError(404, 'Extração concluída não encontrada');
  if (
    body.proposals.some(
      (i) =>
        !i ||
        typeof i !== 'object' ||
        Array.isArray(i) ||
        !Number.isSafeInteger(i.version),
    )
  )
    throw new InputError('Itens de aprovação inválidos');
  const items = body.proposals as Record<string, unknown>[];
  const ids = items.map((i) => uuid(i.id));
  if (new Set(ids).size !== ids.length)
    throw new InputError('Propostas repetidas');
  await ctx.db.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1,241903))',
    [job.project_id],
  );
  const before = (
    await ctx.db.query(
      'SELECT * FROM ai_proposals WHERE extraction_id=$1 AND organization_id=$2 AND id=ANY($3::uuid[]) ORDER BY id FOR UPDATE',
      [jobId, ctx.organizationId, ids],
    )
  ).rows;
  if (before.length !== items.length)
    throw new HttpError(404, 'Proposta não encontrada');
  const created = [];
  for (const p of before) {
    const item = items.find((i) => i.id === p.id)!;
    if (p.state !== 'proposed' || p.version !== item.version)
      throw new HttpError(409, 'Proposta alterada ou já decidida');
    const duplicates = await findDuplicates(
      ctx.db,
      ctx.organizationId,
      job.project_id,
      p.title,
      p.id,
    );
    if (duplicates.length && body.acknowledge_duplicates !== true)
      throw new HttpError(409, 'Revise e confirme as possíveis duplicidades');
    const request = await createRequest(ctx, {
      interaction_id: job.interaction_id,
      title: p.title,
      description: p.description,
      owner_user_id: item.owner_user_id,
      next_action: item.next_action,
    });
    await ctx.db.query(
      'UPDATE requests SET origin_proposal_id=$3,suggested_acceptance_criteria=$4 WHERE id=$1 AND organization_id=$2',
      [
        request.id,
        ctx.organizationId,
        p.id,
        JSON.stringify(p.acceptance_criteria),
      ],
    );
    const after = (
      await ctx.db.query(
        "UPDATE ai_proposals SET state='accepted',request_id=$3,version=version+1,duplicates=$4 WHERE id=$1 AND organization_id=$2 RETURNING *",
        [p.id, ctx.organizationId, request.id, JSON.stringify(duplicates)],
      )
    ).rows[0];
    await ctx.db.query(
      "INSERT INTO proposal_reviews(id,organization_id,proposal_id,actor_user_id,action,before_snapshot,after_snapshot) VALUES($1,$2,$3,$4,'accepted',$5,$6)",
      [crypto.randomUUID(), ctx.organizationId, p.id, ctx.userId, p, after],
    );
    await audit(ctx, 'proposal', p.id, 'accepted:human;not-scope-approval');
    created.push({ proposal_id: p.id, request_id: request.id });
  }
  const result = { created };
  await completeCreation(ctx, path, key!, Response.json(result));
  return result;
}
