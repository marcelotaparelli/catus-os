import { inputHash } from './hash';
import { calendarMinutes } from './engine';
import { clientRollups } from './rollup';
import { createHash } from 'node:crypto';
import { text, uuid } from '../../shared/domain';
import type {
  EconomicKind,
  EconomicRecord,
  TimeEntry,
  EconomicsInput,
  EconomicsResult,
} from '../../shared/economics';
import { authorize, audit } from '../auth/policy';
import type { Context } from '../auth/policy';
import { HttpError } from '../errors';
import { reserveCreation, completeCreation } from '../idempotency';
import {
  fields,
  integer,
  day,
  today,
  one,
  object,
  parsePayload,
  currency,
} from './validation';
import { calculate, laborCost, ENGINE_VERSION, roundRatio } from './engine';
export function financial(ctx: Context) {
  if (!['manager', 'administrator'].includes(ctx.role))
    throw new HttpError(
      403,
      'Custos e taxas são confidenciais: gestor/admin necessário',
    );
}
const dateText = (v: Date | string) =>
  v instanceof Date ? v.toISOString().slice(0, 10) : v.slice(0, 10);
async function lock(ctx: Context) {
  await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,5))', [
    ctx.organizationId,
  ]);
}
async function event(
  ctx: Context,
  type: string,
  id: string,
  action: string,
  data: unknown,
) {
  await ctx.db.query(
    'INSERT INTO economic_events(id,organization_id,entity_type,entity_id,action,actor_user_id,actor_role,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [
      crypto.randomUUID(),
      ctx.organizationId,
      type,
      id,
      action,
      ctx.userId,
      ctx.role,
      JSON.stringify(data),
    ],
  );
  await audit(ctx, type, id, action);
}
async function project(ctx: Context, value: unknown) {
  const p = (
    await ctx.db.query(
      'SELECT * FROM projects WHERE id=$1 AND organization_id=$2',
      [uuid(value), ctx.organizationId],
    )
  ).rows[0];
  if (!p) throw new HttpError(404, 'Projeto não encontrado');
  return p;
}
async function member(ctx: Context, id: unknown) {
  const p = (
    await ctx.db.query(
      'SELECT m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.user_id=$1 AND m.organization_id=$2 AND m.active AND u.active FOR SHARE OF m,u',
      [uuid(id), ctx.organizationId],
    )
  ).rows[0];
  if (!p)
    throw new HttpError(404, 'Profissional indisponível nesta organização');
  return p;
}
async function allRecords(ctx: Context): Promise<EconomicRecord[]> {
  return (
    await ctx.db.query(
      `SELECT r.*,d.decision,d.snapshot decision_snapshot,d.decided_at FROM economic_records r LEFT JOIN economic_decisions d ON d.record_id=r.id AND d.organization_id=r.organization_id WHERE r.organization_id=$1 ORDER BY r.created_at,r.id`,
      [ctx.organizationId],
    )
  ).rows.map((r) => ({
    ...r,
    valid_from: dateText(r.valid_from),
    valid_until: dateText(r.valid_until),
  }));
}
function current(records: EconomicRecord[]) {
  return records.filter(
    (r) =>
      r.decision === 'approved' &&
      !records.some(
        (n) =>
          n.decision === 'approved' &&
          n.series_key === r.series_key &&
          n.revision > r.revision,
      ),
  );
}
async function record(ctx: Context, id: unknown) {
  const r = (await allRecords(ctx)).find((r) => r.id === uuid(id));
  if (!r) throw new HttpError(404, 'Registro econômico não encontrado');
  return r;
}
async function times(
  ctx: Context,
): Promise<(TimeEntry & { snapshot: Record<string, unknown> | null })[]> {
  return (
    await ctx.db.query(
      `SELECT t.*,CASE WHEN EXISTS(SELECT 1 FROM time_events e WHERE e.entry_id=t.id AND e.organization_id=t.organization_id AND e.action='reversed') THEN 'reversed' ELSE COALESCE((SELECT action FROM time_events e WHERE e.entry_id=t.id AND e.organization_id=t.organization_id AND e.action IN ('approved','rejected')),'pending') END state,(SELECT snapshot FROM time_events e WHERE e.entry_id=t.id AND e.organization_id=t.organization_id AND e.action='approved') snapshot FROM time_entries t WHERE t.organization_id=$1 ORDER BY t.created_at,t.id`,
      [ctx.organizationId],
    )
  ).rows.map((r) => ({ ...r, work_date: dateText(r.work_date) }));
}
function selectRate(
  records: EconomicRecord[],
  uid: string,
  role: string,
  on: string,
) {
  const rows = current(records).filter(
    (r) => r.kind === 'rate' && r.valid_from <= on && r.valid_until >= on,
  );
  return (
    rows.find((r) => r.payload.user_id === uid) ??
    rows.find((r) => r.payload.role === role)
  );
}
async function basis(
  ctx: Context,
  scopeId: unknown,
  projectId: string,
  contractId?: unknown,
) {
  const r = (
    await ctx.db.query(
      `SELECT s.*,c.kind contract_kind,c.currency,c.valid_from,c.valid_until,c.state contract_state, (now() AT TIME ZONE 'UTC')::date BETWEEN c.valid_from AND c.valid_until current_valid FROM scope_versions s JOIN contracts c ON c.id=s.contract_id AND c.organization_id=s.organization_id WHERE s.id=$1 AND s.organization_id=$2 AND s.project_id=$3 FOR SHARE OF s,c`,
      [uuid(scopeId), ctx.organizationId, projectId],
    )
  ).rows[0];
  if (
    !r ||
    r.state !== 'approved' ||
    r.contract_state !== 'active' ||
    !r.current_valid ||
    (contractId && r.contract_id !== uuid(contractId))
  )
    throw new HttpError(
      409,
      'Base M3 deve estar aprovada, ativa e vigente neste projeto',
    );
  return r;
}
async function validateAssociation(
  ctx: Context,
  r: Pick<
    EconomicRecord,
    | 'kind'
    | 'payload'
    | 'project_id'
    | 'currency'
    | 'valid_from'
    | 'valid_until'
  >,
  approved: EconomicRecord[],
) {
  const p = r.payload;
  if (r.kind === 'rate' && p.user_id) await member(ctx, p.user_id);
  if (r.kind === 'terms') {
    const b = await basis(ctx, p.scope_id, r.project_id!, p.contract_id);
    if (
      b.currency !== r.currency ||
      r.valid_from < dateText(b.valid_from) ||
      r.valid_until > dateText(b.valid_until)
    )
      throw new HttpError(422, 'Moeda/período incompatível com contrato');
    if (
      b.contract_kind === 'fixed_price' &&
      (p.included_minutes !== null ||
        p.overage_rule !== 'none' ||
        p.rollover_rule !== 'none')
    )
      throw new HttpError(
        422,
        'Preço fechado não usa saldo/rollover de retainer',
      );
    if (
      b.contract_kind === 'fixed_price' &&
      p.recognition_rule === 'manual' &&
      BigInt(String(p.recognized_minor)) > BigInt(String(p.amount_minor))
    )
      throw new HttpError(
        422,
        'Receita reconhecida excede valor aprovado de preço fechado',
      );
    if (b.contract_kind === 'retainer' && p.included_minutes === null)
      throw new HttpError(422, 'Retainer exige minutos incluídos explícitos');
    if (
      p.change_request_id &&
      !(
        await ctx.db.query(
          "SELECT 1 FROM change_requests WHERE id=$1 AND organization_id=$2 AND proposed_scope_id=$3 AND state='approved'",
          [p.change_request_id, ctx.organizationId, p.scope_id],
        )
      ).rowCount
    )
      throw new HttpError(
        409,
        'Aditivo de escopo exige change request M3 aprovado',
      );
    if (p.prior_terms_id) {
      const prior = approved.find(
        (x) =>
          x.id === p.prior_terms_id &&
          x.kind === 'terms' &&
          x.payload.contract_id === p.contract_id &&
          x.valid_until < r.valid_from,
      );
      if (
        !prior ||
        prior.currency !== r.currency ||
        prior.valid_until >= today()
      )
        throw new HttpError(
          409,
          'Rollover exige período anterior encerrado, aprovado e mesma moeda',
        );
      const ts = (await times(ctx)).filter(
        (t) =>
          t.project_id === r.project_id &&
          t.work_date >= prior.valid_from &&
          t.work_date <= prior.valid_until,
      );
      if (ts.some((t) => t.state === 'pending'))
        throw new HttpError(
          409,
          'Decidir todas as horas do período anterior antes do rollover',
        );
      const used = ts
          .filter((t) => t.state === 'approved')
          .reduce((a, t) => a + t.minutes, 0),
        available = Math.max(
          0,
          Number(prior.payload.included_minutes) +
            Number(prior.payload.carry_in_minutes) -
            used,
        );
      if (
        prior.payload.rollover_rule !== 'carry_capped' ||
        Number(p.carry_in_minutes) >
          Math.min(
            available,
            Number(prior.payload.rollover_cap_minutes),
            Number(p.rollover_cap_minutes),
          )
      )
        throw new HttpError(
          422,
          'Rollover excede saldo/teto explicitamente autorizado',
        );
    }
  }
  if (r.kind === 'estimate' || r.kind === 'direct_cost') {
    const term = approved.find(
      (t) =>
        t.id === p.terms_id &&
        t.kind === 'terms' &&
        t.project_id === r.project_id,
    );
    if (
      !term ||
      term.currency !== r.currency ||
      term.valid_from !== r.valid_from ||
      term.valid_until !== r.valid_until
    )
      throw new HttpError(
        409,
        'Termos aprovados da mesma competência/moeda obrigatórios',
      );
    await basis(
      ctx,
      term.payload.scope_id,
      r.project_id!,
      term.payload.contract_id,
    );
    if (r.kind === 'estimate') {
      await member(ctx, p.user_id);
      const req = (
        await ctx.db.query(
          'SELECT r.scope_item_id,i.project_id,si.scope_id FROM requests r JOIN interactions i ON i.id=r.interaction_id AND i.organization_id=r.organization_id LEFT JOIN scope_items si ON si.id=r.scope_item_id AND si.organization_id=r.organization_id WHERE r.id=$1 AND r.organization_id=$2 FOR SHARE OF r',
          [uuid(p.request_id), ctx.organizationId],
        )
      ).rows[0];
      if (
        !req ||
        req.project_id !== r.project_id ||
        req.scope_id !== term.payload.scope_id
      )
        throw new HttpError(
          409,
          'Estimativa exige demanda coberta pelo escopo M3 dos termos',
        );
      if (
        String(p.expected_on) < r.valid_from ||
        String(p.expected_on) > r.valid_until
      )
        throw new HttpError(422, 'Data prevista fora da competência');
    }
  }
  if (r.kind === 'capacity') await member(ctx, p.user_id);
}
function series(
  kind: EconomicKind,
  p: Record<string, unknown>,
  pid: string | null,
  from: string,
  until: string,
) {
  const period = from + ':' + until;
  if (kind === 'config') return kind + ':' + period;
  if (kind === 'rate') return kind + ':' + (p.user_id ?? p.role) + ':' + period;
  if (kind === 'terms') return kind + ':' + pid + ':' + period;
  if (kind === 'estimate')
    return kind + ':' + p.terms_id + ':' + p.request_id + ':' + p.user_id;
  if (kind === 'capacity')
    return kind + ':' + pid + ':' + p.user_id + ':' + period;
  return kind + ':' + p.terms_id + ':' + p.expense_key;
}
export async function createRecord(ctx: Context, b: Record<string, unknown>) {
  fields(b, [
    'kind',
    'project_id',
    'currency',
    'valid_from',
    'valid_until',
    'source',
    'payload',
    'previous_id',
  ]);
  const kind = one(b.kind, [
    'config',
    'rate',
    'terms',
    'estimate',
    'capacity',
    'direct_cost',
  ]);
  if (kind === 'estimate') authorize(ctx, 'create');
  else financial(ctx);
  const pid =
    b.project_id === null
      ? null
      : ((await project(ctx, b.project_id)).id as string);
  if (['config', 'rate'].includes(kind) ? pid !== null : pid === null)
    throw new HttpError(422, 'Escopo do registro inválido');
  const from = day(b.valid_from),
    until = day(b.valid_until);
  if (until < from) throw new HttpError(422, 'Vigência inválida');
  const payload = parsePayload(kind, object(b.payload)),
    cur = currency(b.currency),
    records = await allRecords(ctx),
    approved = current(records);
  await validateAssociation(
    ctx,
    {
      kind,
      payload,
      project_id: pid,
      currency: cur,
      valid_from: from,
      valid_until: until,
    },
    approved,
  );
  const sk =
      series(kind, payload, pid, from, until) +
      (kind === 'config' ? ':' + cur : ''),
    previous =
      b.previous_id == null
        ? null
        : records.find((r) => r.id === uuid(b.previous_id));
  const existing = records
    .filter((r) => r.series_key === sk)
    .sort((a, b) => b.revision - a.revision)[0];
  if (
    (existing && !previous) ||
    (!existing && previous) ||
    (existing && previous?.id !== existing.id) ||
    (previous?.currency && previous.currency !== cur)
  )
    throw new HttpError(
      409,
      'Criar nova revisão exige previous_id da última versão, com mesma moeda/série',
    );
  if (existing && existing.decision === null)
    throw new HttpError(
      409,
      'Decida a versão pendente antes de preparar outra',
    );
  if (
    kind === 'terms' &&
    previous &&
    previous.payload.scope_id !== payload.scope_id &&
    !payload.change_request_id
  )
    throw new HttpError(
      422,
      'Mudança de escopo econômico exige aditivo M3 aprovado',
    );
  if (
    kind === 'estimate' &&
    previous &&
    previous.payload.planned_minutes !== payload.planned_minutes
  )
    throw new HttpError(
      422,
      'Baseline previsto é imutável; ajuste restante ou crie base de novo escopo',
    );
  const id = crypto.randomUUID(),
    revision = (existing?.revision ?? 0) + 1;
  const r = (
    await ctx.db.query(
      'INSERT INTO economic_records(id,organization_id,project_id,kind,series_key,revision,previous_id,currency,valid_from,valid_until,source,payload,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *',
      [
        id,
        ctx.organizationId,
        pid,
        kind,
        sk,
        revision,
        previous?.id ?? null,
        cur,
        from,
        until,
        text(b.source, 'Fonte', 2000),
        JSON.stringify(payload),
        ctx.userId,
      ],
    )
  ).rows[0];
  await event(ctx, 'economic_record', id, 'prepared', {
    kind,
    revision,
    source: r.source,
  });
  return r;
}
export async function decideRecord(
  ctx: Context,
  id: string,
  b: Record<string, unknown>,
) {
  financial(ctx);
  fields(b, ['revision', 'decision', 'reason', 'cost_role']);
  const r = await record(ctx, id);
  if (r.created_by === ctx.userId)
    throw new HttpError(
      403,
      'Preparador não pode aprovar o próprio impacto econômico',
    );
  if (r.revision !== integer(b.revision, 'Revisão', 100000, 1) || r.decision)
    throw new HttpError(409, 'Registro já decidido ou revisão mudou');
  const policy = (
    await ctx.db.query(
      'SELECT * FROM commercial_policies WHERE organization_id=$1 FOR SHARE',
      [ctx.organizationId],
    )
  ).rows[0];
  if (!policy?.approval_roles.includes(ctx.role))
    throw new HttpError(403, 'Alçada M3 não autoriza decisão econômica');
  const decision = one(b.decision, ['approved', 'rejected']),
    records = await allRecords(ctx),
    approved = current(records);
  let snapshot: Record<string, unknown> = {};
  if (decision === 'approved') {
    await validateAssociation(ctx, r, approved);
    if (['config', 'rate', 'terms', 'capacity'].includes(r.kind)) {
      const conflicting = approved.find(
        (t) =>
          t.kind === r.kind &&
          t.series_key !== r.series_key &&
          (r.kind !== 'config' || t.currency === r.currency) &&
          t.valid_from <= r.valid_until &&
          t.valid_until >= r.valid_from &&
          (r.kind === 'config' ||
            (r.kind === 'rate' &&
              (t.payload.user_id ?? t.payload.role) ===
                (r.payload.user_id ?? r.payload.role)) ||
            (r.kind === 'terms' && t.project_id === r.project_id) ||
            (r.kind === 'capacity' &&
              t.project_id === r.project_id &&
              t.payload.user_id === r.payload.user_id)),
      );
      if (conflicting)
        throw new HttpError(
          409,
          'Vigências sobrepostas: use revisão da série ou período não sobreposto',
        );
    }
    if (r.kind === 'capacity') {
      const config = approved.find(
        (c) =>
          c.kind === 'config' &&
          c.currency === r.currency &&
          c.valid_from <= r.valid_from &&
          c.valid_until >= r.valid_until,
      );
      if (!config)
        throw new HttpError(
          409,
          'Capacidade exige calendário explícito vigente',
        );
      const others = approved.filter(
        (c) =>
          c.kind === 'capacity' &&
          c.series_key !== r.series_key &&
          c.payload.user_id === r.payload.user_id &&
          c.valid_from <= r.valid_until &&
          c.valid_until >= r.valid_from,
      );
      if (
        others.some(
          (c) =>
            c.valid_from !== r.valid_from || c.valid_until !== r.valid_until,
        )
      )
        throw new HttpError(
          409,
          'Alocações sobrepostas devem usar a mesma competência para evitar capacidade duplicada',
        );
      const limit = calendarMinutes(
        r.valid_from,
        r.valid_until,
        config.payload.weekdays as number[],
        Number(config.payload.minutes_per_day),
        config.payload.holidays as string[],
      );
      if (
        Number(r.payload.available_minutes) +
          others.reduce((n, c) => n + Number(c.payload.available_minutes), 0) >
        limit
      )
        throw new HttpError(
          422,
          'Capacidade alocada excede calendário explícito',
        );
      snapshot = { calendar_id: config.id, calendar_limit_minutes: limit };
    }
    if (r.kind === 'terms' && r.payload.prior_terms_id) {
      snapshot = {
        prior_terms_id: r.payload.prior_terms_id,
        prior_entries: (await times(ctx))
          .filter(
            (t) => t.project_id === r.project_id && t.work_date < r.valid_from,
          )
          .map((t) => ({ id: t.id, minutes: t.minutes, state: t.state })),
      };
    }
    if (r.kind === 'estimate') {
      const m = await member(ctx, r.payload.user_id),
        rate = selectRate(
          records,
          String(r.payload.user_id),
          b.cost_role == null
            ? ''
            : one(b.cost_role, ['administrator', 'manager', 'po', 'developer']),
          String(r.payload.expected_on),
        );
      snapshot = {
        rate_id: rate?.id ?? null,
        minor_per_hour: rate?.payload.minor_per_hour ?? null,
        currency: rate?.currency ?? null,
        user_role: m.role,
        cost_role: b.cost_role ?? null,
      };
    }
  }
  await ctx.db.query(
    'INSERT INTO economic_decisions(record_id,organization_id,decision,actor_user_id,actor_role,policy_version,reason,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [
      r.id,
      ctx.organizationId,
      decision,
      ctx.userId,
      ctx.role,
      policy.version,
      text(b.reason, 'Justificativa', 2000),
      JSON.stringify(snapshot),
    ],
  );
  await event(ctx, 'economic_record', r.id, decision, {
    revision: r.revision,
    policy_version: policy.version,
  });
  return { id: r.id, decision };
}
export async function createTime(ctx: Context, b: Record<string, unknown>) {
  fields(b, [
    'project_id',
    'request_id',
    'work_date',
    'minutes',
    'comment',
    'replaces_id',
  ]);
  authorize(ctx, 'read');
  const p = await project(ctx, b.project_id),
    rid = uuid(b.request_id);
  if (
    !(
      await ctx.db.query(
        'SELECT 1 FROM requests r JOIN interactions i ON i.id=r.interaction_id AND i.organization_id=r.organization_id WHERE r.id=$1 AND r.organization_id=$2 AND i.project_id=$3',
        [rid, ctx.organizationId, p.id],
      )
    ).rowCount
  )
    throw new HttpError(404, 'Demanda não encontrada neste projeto');
  const work = day(b.work_date);
  if (work > today()) throw new HttpError(422, 'Não apontar horas futuras');
  const minutes = integer(b.minutes, 'Duração', 1440, 1),
    comment = text(b.comment, 'Comentário', 2000),
    entries = await times(ctx);
  const active = entries.filter(
    (t) =>
      t.user_id === ctx.userId &&
      t.work_date === work &&
      !['rejected', 'reversed'].includes(t.state),
  );
  if (active.reduce((a, t) => a + t.minutes, 0) + minutes > 1440)
    throw new HttpError(422, 'Duração diária excede 1440 minutos');
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([ctx.userId, rid, work, minutes, comment]))
    .digest('hex');
  if (
    active.some(
      (t) =>
        t.request_id === rid && t.minutes === minutes && t.comment === comment,
    )
  )
    throw new HttpError(
      409,
      'Apontamento idêntico já existe; confira antes de repetir',
    );
  const replaces = b.replaces_id == null ? null : uuid(b.replaces_id);
  if (
    replaces &&
    !entries.some(
      (t) =>
        t.id === replaces &&
        t.user_id === ctx.userId &&
        ['rejected', 'reversed'].includes(t.state),
    )
  )
    throw new HttpError(
      409,
      'Correção exige entrada própria revertida/rejeitada',
    );
  const id = crypto.randomUUID();
  await ctx.db.query(
    'INSERT INTO time_entries(id,organization_id,project_id,request_id,user_id,work_date,minutes,comment,replaces_id,fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [
      id,
      ctx.organizationId,
      p.id,
      rid,
      ctx.userId,
      work,
      minutes,
      comment,
      replaces,
      fingerprint,
    ],
  );
  await event(ctx, 'time_entry', id, 'recorded', {
    minutes,
    work_date: work,
    request_id: rid,
    replaces_id: replaces,
  });
  return { id, state: 'pending' };
}
export async function timeAction(
  ctx: Context,
  id: string,
  b: Record<string, unknown>,
) {
  fields(b, ['expected_state', 'action', 'reason', 'cost_role']);
  const t = (await times(ctx)).find((t) => t.id === uuid(id));
  if (!t) throw new HttpError(404, 'Apontamento não encontrado');
  if (t.state !== b.expected_state)
    throw new HttpError(409, 'Apontamento mudou; recarregue');
  const action = one(b.action, ['approved', 'rejected', 'reversed']);
  if (
    action === 'reversed' &&
    t.state === 'pending' &&
    t.user_id === ctx.userId
  ) {
  } else {
    financial(ctx);
    if (t.user_id === ctx.userId)
      throw new HttpError(403, 'Sem aprovação das próprias horas');
  }
  if (
    ['rejected', 'reversed'].includes(t.state) ||
    (action !== 'reversed' && t.state !== 'pending')
  )
    throw new HttpError(409, 'Transição de horas inválida');
  let snapshot: Record<string, unknown> = {};
  if (action === 'approved') {
    const m = await member(ctx, t.user_id),
      rate = selectRate(
        await allRecords(ctx),
        t.user_id,
        b.cost_role == null
          ? ''
          : one(b.cost_role, ['administrator', 'manager', 'po', 'developer']),
        t.work_date,
      );
    snapshot = {
      rate_id: rate?.id ?? null,
      minor_per_hour: rate?.payload.minor_per_hour ?? null,
      currency: rate?.currency ?? null,
      cost_minor: rate
        ? laborCost(t.minutes, String(rate.payload.minor_per_hour))
        : null,
      user_role: m.role,
      cost_role: b.cost_role ?? null,
    };
  }
  await ctx.db.query(
    'INSERT INTO time_events(id,organization_id,entry_id,action,actor_user_id,actor_role,reason,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [
      crypto.randomUUID(),
      ctx.organizationId,
      t.id,
      action,
      ctx.userId,
      ctx.role,
      text(b.reason, 'Justificativa', 2000),
      JSON.stringify(snapshot),
    ],
  );
  await event(ctx, 'time_entry', t.id, action, {
    expected_state: t.state,
    reason: b.reason,
  });
  return { id: t.id, state: action };
}
export async function generateReport(ctx: Context, b: Record<string, unknown>) {
  financial(ctx);
  fields(b, ['terms_id', 'as_of']);
  const records = await allRecords(ctx),
    approved = current(records),
    term = approved.find(
      (r) => r.id === uuid(b.terms_id) && r.kind === 'terms',
    );
  if (!term) throw new HttpError(409, 'Termos aprovados atuais obrigatórios');
  const asof = day(b.as_of);
  if (asof > today() || asof < term.valid_from)
    throw new HttpError(422, 'Data de corte inválida');
  const p = await project(ctx, term.project_id),
    contract = (
      await ctx.db.query(
        'SELECT * FROM contracts WHERE id=$1 AND organization_id=$2',
        [uuid(term.payload.contract_id), ctx.organizationId],
      )
    ).rows[0];
  const scoped = (
    await ctx.db.query(
      'SELECT * FROM scope_versions WHERE id=$1 AND organization_id=$2',
      [uuid(term.payload.scope_id), ctx.organizationId],
    )
  ).rows[0];
  const config = approved.find(
    (r) =>
      r.kind === 'config' &&
      r.currency === term.currency &&
      r.valid_from <= term.valid_from &&
      r.valid_until >= term.valid_until,
  );
  const estimates = approved.filter(
      (r) => r.kind === 'estimate' && r.payload.terms_id === term.id,
    ),
    costs = approved.filter(
      (r) => r.kind === 'direct_cost' && r.payload.terms_id === term.id,
    ),
    capacities = approved.filter(
      (r) =>
        r.kind === 'capacity' &&
        r.project_id === term.project_id &&
        r.valid_from === term.valid_from &&
        r.valid_until === term.valid_until &&
        r.currency === term.currency,
    );
  const entries = (await times(ctx)).filter(
    (t) =>
      t.project_id === term.project_id &&
      t.work_date >= term.valid_from &&
      t.work_date <= term.valid_until &&
      t.work_date <= asof,
  );
  const pm: string[] = [],
    am: string[] = [],
    alerts: string[] = [];
  if (
    !contract ||
    contract.state !== 'active' ||
    scoped?.state !== 'approved' ||
    asof < dateText(contract.valid_from) ||
    asof > dateText(contract.valid_until)
  ) {
    pm.push('cobertura M3 atual/contrato vigente');
    alerts.push('Base comercial não vigente; não autoriza trabalho');
  }
  const scopeItems = (
    await ctx.db.query(
      'SELECT id FROM scope_items WHERE scope_id=$1 AND organization_id=$2',
      [scoped.id, ctx.organizationId],
    )
  ).rows;
  const requestCoverage = (
    await ctx.db.query(
      'SELECT r.id,r.scope_item_id FROM requests r JOIN interactions i ON i.id=r.interaction_id AND i.organization_id=r.organization_id WHERE r.organization_id=$1 AND i.project_id=$2',
      [ctx.organizationId, p.id],
    )
  ).rows;
  for (const si of scopeItems)
    if (
      !estimates.some((e) =>
        requestCoverage.some(
          (q) => q.id === e.payload.request_id && q.scope_item_id === si.id,
        ),
      )
    )
      pm.push('estimativa para item ' + si.id);
  for (const t of entries.filter((t) =>
    ['approved', 'pending'].includes(t.state),
  ))
    if (
      !scopeItems.some((si) =>
        requestCoverage.some(
          (q) => q.id === t.request_id && q.scope_item_id === si.id,
        ),
      )
    ) {
      pm.push('atividade sem cobertura M3 ' + t.id);
      alerts.push('Horas em demanda sem cobertura comercial');
    }
  const payload = term.payload,
    recognized =
      payload.recognition_rule === 'manual'
        ? String(payload.recognized_minor)
        : payload.recognition_rule === 'at_period_end' &&
            asof >= term.valid_until
          ? String(payload.amount_minor)
          : null;
  const input: EconomicsInput = {
    currency: term.currency,
    period_from: term.valid_from,
    period_until: term.valid_until,
    as_of: asof,
    regime: contract.kind,
    revenue: String(payload.amount_minor),
    recognized,
    included_minutes:
      payload.included_minutes === null
        ? null
        : Number(payload.included_minutes),
    carry_in_minutes: Number(payload.carry_in_minutes),
    overage_rule: payload.overage_rule as 'none' | 'billable',
    overage_rate:
      payload.overage_rate_minor === null
        ? null
        : String(payload.overage_rate_minor),
    config: config
      ? {
          tax_bps: Number(config.payload.tax_bps),
          commission_bps: Number(config.payload.commission_bps),
          overhead_rule: config.payload.overhead_rule as
            | 'none_explicit'
            | 'per_labor_minute',
          overhead_rate:
            config.payload.overhead_minor_per_hour === null
              ? null
              : String(config.payload.overhead_minor_per_hour),
        }
      : null,
    actuals: entries
      .filter((t) => t.state === 'approved')
      .map((t) => ({
        id: t.id,
        minutes: t.minutes,
        cost:
          t.snapshot?.cost_minor == null ? null : String(t.snapshot.cost_minor),
        currency:
          t.snapshot?.currency == null ? null : String(t.snapshot.currency),
      })),
    pending_minutes: entries
      .filter((t) => t.state === 'pending')
      .reduce((a, t) => a + t.minutes, 0),
    estimates: estimates.map((e) => ({
      id: e.id,
      planned_minutes: Number(e.payload.planned_minutes),
      remaining_minutes: Number(e.payload.remaining_minutes),
      rate:
        e.decision_snapshot?.minor_per_hour == null
          ? null
          : String(e.decision_snapshot.minor_per_hour),
      currency:
        e.decision_snapshot?.currency == null
          ? null
          : String(e.decision_snapshot.currency),
    })),
    direct: costs.flatMap((c) =>
      (['incurred', 'remaining', 'budget'] as const).map((stage) => ({
        id: c.id + ':' + stage,
        stage,
        amount: String(c.payload[stage + '_minor']),
        currency: c.currency,
      })),
    ),
    capacity_minutes: capacities.length
      ? capacities.reduce((a, c) => a + Number(c.payload.available_minutes), 0)
      : null,
    direct_costs_complete: payload.direct_costs_complete === true,
    time_entries_complete: payload.time_entries_complete === true,
    projection_missing: pm,
    actual_missing: am,
    alerts,
  };
  const result = calculate(input),
    id = crypto.randomUUID(),
    inputs = {
      engine_input: input,
      terms: term,
      config: config ?? null,
      estimates,
      costs,
      capacities,
      time_entries: entries,
      commercial_basis: {
        contract_id: contract.id,
        scope_id: scoped.id,
        scope_number: scoped.number,
        contract_kind: contract.kind,
        currency: contract.currency,
        valid_from: dateText(contract.valid_from),
        valid_until: dateText(contract.valid_until),
      },
      client_id: p.client_id,
    };
  const json = JSON.stringify(inputs),
    hash = inputHash(inputs);
  await ctx.db.query(
    'INSERT INTO economic_reports(id,organization_id,project_id,terms_id,as_of,engine_version,inputs,result,input_hash,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [
      id,
      ctx.organizationId,
      p.id,
      term.id,
      asof,
      ENGINE_VERSION,
      json,
      JSON.stringify(result),
      hash,
      ctx.userId,
    ],
  );
  await event(ctx, 'economic_report', id, 'calculated', {
    terms_id: term.id,
    as_of: asof,
    input_hash: hash,
    engine_version: ENGINE_VERSION,
  });
  return { id, result, input_hash: hash };
}
export async function economicsView(ctx: Context) {
  authorize(ctx, 'read');
  const records = await allRecords(ctx),
    entries = await times(ctx);
  if (!['manager', 'administrator'].includes(ctx.role))
    return {
      records:
        ctx.role === 'po'
          ? records
              .filter(
                (r) =>
                  r.kind === 'estimate' ||
                  (r.kind === 'terms' && r.decision === 'approved'),
              )
              .map((r) =>
                r.kind === 'estimate'
                  ? { ...r, decision_snapshot: undefined }
                  : {
                      id: r.id,
                      kind: r.kind,
                      project_id: r.project_id,
                      currency: r.currency,
                      valid_from: r.valid_from,
                      valid_until: r.valid_until,
                      payload: {
                        scope_id: r.payload.scope_id,
                        contract_id: r.payload.contract_id,
                      },
                      decision: r.decision,
                    },
              )
          : [],
      times: entries
        .filter((t) => t.user_id === ctx.userId)
        .map(({ snapshot, ...t }) => t),
      reports: [],
      events: [],
    };
  const reports = (
    await ctx.db.query(
      'SELECT * FROM economic_reports WHERE organization_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100',
      [ctx.organizationId],
    )
  ).rows;
  const projects = (
    await ctx.db.query(
      'SELECT id,client_id FROM projects WHERE organization_id=$1',
      [ctx.organizationId],
    )
  ).rows;
  return {
    records,
    times: entries.map(({ snapshot, ...t }) => t),
    reports,
    clients: clientRollups(reports).map((group) => {
      const observed = new Set(
        reports
          .filter((r) => group.report_ids.includes(r.id))
          .map((r) => r.project_id),
      );
      const missing = projects
        .filter((p) => p.client_id === group.client_id && !observed.has(p.id))
        .map((p) => 'projeto sem observação comparável ' + p.id);
      return missing.length
        ? {
            ...group,
            projected_margin: null,
            projected_margin_bps: null,
            realized_margin: null,
            projection_missing: [...group.projection_missing, ...missing],
            actual_missing: [...group.actual_missing, ...missing],
          }
        : group;
    }),
    events: (
      await ctx.db.query(
        'SELECT * FROM economic_events WHERE organization_id=$1 ORDER BY created_at DESC,id DESC LIMIT 200',
        [ctx.organizationId],
      )
    ).rows,
  };
}
export async function economicRoute(
  ctx: Context,
  path: string,
  method: string,
  b: Record<string, unknown> | undefined,
  key: string | null,
): Promise<Response | undefined> {
  if (method === 'GET' && path === '/api/economics')
    return Response.json(await economicsView(ctx));
  if (method !== 'POST' || !b) return undefined;
  const decision = /^\/api\/economics\/records\/([^/]+)\/decide$/.exec(path),
    time = /^\/api\/economics\/times\/([^/]+)\/action$/.exec(path);
  if (
    ![
      '/api/economics/records',
      '/api/economics/times',
      '/api/economics/reports',
    ].includes(path) &&
    !decision &&
    !time
  )
    return undefined;
  if (path.endsWith('/records') && b.kind === 'estimate')
    authorize(ctx, 'create');
  else if (!path.endsWith('/times') && !time) financial(ctx);
  await lock(ctx);
  // Confidential cached responses still require current rights; self-authority is never inferred.
  const previous = await reserveCreation(ctx, path, key, b);
  if (previous)
    return Response.json(previous.body, {
      status: previous.status,
      headers: { 'Idempotency-Replayed': 'true' },
    });
  let result: unknown;
  if (decision) result = await decideRecord(ctx, decision[1]!, b);
  else if (time) result = await timeAction(ctx, time[1]!, b);
  else if (path.endsWith('/records')) result = await createRecord(ctx, b);
  else if (path.endsWith('/times')) result = await createTime(ctx, b);
  else result = await generateReport(ctx, b);
  const r = Response.json(result, { status: decision || time ? 200 : 201 });
  await completeCreation(ctx, path, key!, r);
  return r;
}
