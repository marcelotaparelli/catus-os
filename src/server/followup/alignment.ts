// Alinhamento e Aceite. Every fact is one append-only row in request_alignment. Only a person
// records a client's answer, always pointing at the interaction that shows it: nothing here
// or in the automation turns time or silence into acceptance.
import { dayText, InputError, text, uuid } from '../../shared/domain';
import type { Status } from '../../shared/domain';
import { defaultFollowUp } from '../../shared/followup';
import type { Alignment, TemplateId } from '../../shared/followup';
import { audit, authorize } from '../auth/policy';
import type { Context } from '../auth/policy';
import { HttpError } from '../errors';

/** Same columns for one demand or for the whole queue: `r` is the demand. */
export const alignmentColumns = `al.agreement_version,al.criteria,al.high_risk,al.confirmed_version,al.authorized_version,al.last_step,al.delivered_at,al.rejections`;
export const alignmentJoin = `LEFT JOIN LATERAL (SELECT max(agreement_version) FILTER (WHERE kind='agreement') agreement_version,
 (array_agg(criteria ORDER BY agreement_version DESC) FILTER (WHERE kind='agreement'))[1] criteria,
 (array_agg(high_risk ORDER BY agreement_version DESC) FILTER (WHERE kind='agreement'))[1] high_risk,
 max(agreement_version) FILTER (WHERE kind='confirmation') confirmed_version,
 max(agreement_version) FILTER (WHERE kind='risk_authorization') authorized_version,
 (array_agg(kind ORDER BY recorded_at DESC) FILTER (WHERE kind IN ('delivered','accepted','rejected','closed_without_acceptance')))[1] last_step,
 max(recorded_at) FILTER (WHERE kind='delivered') delivered_at,
 count(*) FILTER (WHERE kind='rejected')::int rejections
 FROM request_alignment a WHERE a.request_id=r.id AND a.organization_id=r.organization_id) al ON true`;

export interface AlignmentRow {
  agreement_version: number | null;
  criteria: string | null;
  high_risk: boolean | null;
  confirmed_version: number | null;
  authorized_version: number | null;
  last_step: string | null;
  delivered_at: Date | null;
  rejections: number;
}
export function alignmentOf(r: AlignmentRow): Alignment | null {
  const version = r.agreement_version;
  if (!version) return null;
  return {
    version,
    criteria: r.criteria!,
    high_risk: !!r.high_risk,
    confirmed: r.confirmed_version === version,
    authorized: r.authorized_version === version,
    delivered_at:
      r.last_step === 'delivered' ? r.delivered_at!.toISOString() : null,
    rejections: r.rejections,
  };
}

async function record(
  ctx: Context,
  requestId: string,
  kind: string,
  v: {
    version?: number | null;
    criteria?: string;
    highRisk?: boolean;
    reason?: string | null;
    evidence?: string;
    executor?: boolean;
  } = {},
) {
  await ctx.db.query(
    'INSERT INTO request_alignment(organization_id,request_id,kind,agreement_version,criteria,high_risk,reason,evidence_interaction_id,recorded_by,recorded_by_executor) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [
      ctx.organizationId,
      requestId,
      kind,
      v.version ?? null,
      v.criteria ?? null,
      v.highRisk ?? null,
      v.reason ?? null,
      v.evidence ?? null,
      ctx.userId,
      v.executor ?? false,
    ],
  );
  await audit(
    ctx,
    'request',
    requestId,
    `alignment:${kind}${v.executor ? ';by_executor' : ''}`,
  );
}

/**
 * What a change of stage must respect, called with the demand already locked. Returns nothing:
 * it refuses only high-risk work without a person's authorization and a developer closing
 * what has criteria. Everything else proceeds and stays on record.
 */
export async function guardStage(
  ctx: Context,
  requestId: string,
  template: TemplateId | null,
  next: Status,
) {
  if (next !== 'in_progress' && next !== 'done') return;
  const r = (
    await ctx.db.query<AlignmentRow>(
      `SELECT ${alignmentColumns} FROM requests r ${alignmentJoin} WHERE r.id=$1 AND r.organization_id=$2`,
      [requestId, ctx.organizationId],
    )
  ).rows[0]!;
  const a = alignmentOf(r);
  if (a?.high_risk && !a.authorized)
    throw new HttpError(
      403,
      'Operação de alto risco: precisa da autorização de um gestor ou administrador',
    );
  if (next === 'in_progress') {
    if (template === 'implantacao' && !a?.confirmed)
      await audit(ctx, 'request', requestId, 'started_without_confirmation');
    return;
  }
  if (a && ctx.role === 'developer')
    throw new HttpError(
      403,
      'Esta demanda tem critérios de aceite: marque como entregue, e o aceite é registrado por PO ou gestor',
    );
  if (a || template === 'implantacao')
    await record(ctx, requestId, 'closed_without_acceptance', {
      version: a?.version,
    });
}

/** The evidence must be something recorded in the demand's own project. */
async function evidence(
  ctx: Context,
  projectId: string,
  value: unknown,
  notBefore?: Date | null,
) {
  const id = uuid(value);
  const row = (
    await ctx.db.query<{ occurred_at: Date }>(
      'SELECT occurred_at FROM interactions WHERE id=$1 AND organization_id=$2 AND project_id=$3',
      [id, ctx.organizationId, projectId],
    )
  ).rows[0];
  if (!row)
    throw new HttpError(
      422,
      'A evidência precisa ser um atendimento do mesmo projeto',
    );
  if (notBefore && row.occurred_at < notBefore)
    throw new HttpError(422, 'A evidência precisa ser posterior à entrega');
  return id;
}

export async function recordAlignment(
  ctx: Context,
  id: string,
  body: Record<string, unknown>,
) {
  authorize(ctx, 'update');
  const requestId = uuid(id),
    kind = String(body.kind);
  if (!Number.isSafeInteger(body.version) || Number(body.version) < 1)
    throw new InputError('Versão obrigatória');
  const r = (
    await ctx.db.query<
      AlignmentRow & {
        status: Status;
        version: number;
        template: TemplateId | null;
        owner_user_id: string | null;
        project_id: string;
      }
    >(
      `SELECT r.status,r.version,r.template,r.owner_user_id,i.project_id,${alignmentColumns} FROM (SELECT * FROM requests WHERE id=$1 AND organization_id=$2 FOR UPDATE) r JOIN interactions i ON i.id=r.interaction_id AND i.organization_id=r.organization_id ${alignmentJoin}`,
      [requestId, ctx.organizationId],
    )
  ).rows[0];
  if (!r) throw new HttpError(404, 'Solicitação não encontrada');
  const isOwner = r.owner_user_id === ctx.userId;
  // Only the owner, among developers, can mark a delivery. Nothing else is theirs to record.
  if (ctx.role === 'developer' && !(kind === 'delivered' && isOwner))
    throw new HttpError(403, 'Operação não permitida');
  if (r.version !== body.version)
    throw new HttpError(409, 'Solicitação alterada; recarregue os dados');
  if (r.status === 'done') throw new HttpError(409, 'Solicitação já concluída');
  const a = alignmentOf(r),
    needAgreement = () => {
      if (!a) throw new HttpError(409, 'Registre o combinado antes');
      return a;
    };
  let status: Status = r.status,
    nextAction: string | null = null,
    followUp: string | null = null;
  const renewed = () =>
    defaultFollowUp(new Date().toISOString().slice(0, 10), r.template);
  switch (kind) {
    case 'agreement': {
      const highRisk = body.high_risk === true,
        version = (a?.version ?? 0) + 1;
      // Dropping the risk mark would remove the authorization step: only who authorizes can.
      if (a?.high_risk && !highRisk && ctx.role === 'po')
        throw new HttpError(
          403,
          'Só gestor ou administrador retira o alto risco',
        );
      await record(ctx, requestId, kind, {
        version,
        criteria: text(body.criteria, 'Critérios de aceite', 4000),
        highRisk,
        reason: a ? text(body.reason, 'Motivo da mudança', 2000) : null,
      });
      break;
    }
    case 'confirmation':
      await record(ctx, requestId, kind, {
        version: needAgreement().version,
        evidence: await evidence(
          ctx,
          r.project_id,
          body.evidence_interaction_id,
        ),
      });
      break;
    case 'risk_authorization':
      if (ctx.role !== 'manager' && ctx.role !== 'administrator')
        throw new HttpError(
          403,
          'Só gestor ou administrador autoriza alto risco',
        );
      if (!needAgreement().high_risk)
        throw new HttpError(
          409,
          'Esta demanda não está marcada como alto risco',
        );
      await record(ctx, requestId, kind, { version: a!.version });
      break;
    case 'delivered':
      if (needAgreement().delivered_at || r.status !== 'in_progress')
        throw new HttpError(
          409,
          'Só uma demanda em execução pode ser entregue',
        );
      if (a!.high_risk && !a!.authorized)
        throw new HttpError(
          403,
          'Operação de alto risco: precisa de autorização',
        );
      await record(ctx, requestId, kind, { version: a!.version });
      nextAction = 'Registrar a resposta do cliente sobre a entrega';
      followUp = renewed();
      break;
    case 'accepted':
    case 'rejected': {
      if (ctx.role === 'developer')
        throw new HttpError(403, 'Operação não permitida');
      const delivered = needAgreement().delivered_at;
      if (!delivered || r.status !== 'in_progress')
        throw new HttpError(409, 'A demanda não está aguardando aceite');
      // Hours that were reversed are not work. Marking the delivery counts as executing it.
      const worked = (
        await ctx.db.query(
          `SELECT 1 FROM time_entries t WHERE t.organization_id=$1 AND t.request_id=$2 AND t.user_id=$3 AND NOT EXISTS(SELECT 1 FROM time_events e WHERE e.entry_id=t.id AND e.organization_id=t.organization_id AND e.action='reversed')
 UNION ALL SELECT 1 FROM request_alignment a WHERE a.organization_id=$1 AND a.request_id=$2 AND a.recorded_by=$3 AND a.kind='delivered' LIMIT 1`,
          [ctx.organizationId, requestId, ctx.userId],
        )
      ).rowCount;
      const reason =
        kind === 'rejected'
          ? text(body.reason, 'Motivo da recusa', 2000)
          : null;
      await record(ctx, requestId, kind, {
        version: a!.version,
        evidence: await evidence(
          ctx,
          r.project_id,
          body.evidence_interaction_id,
          new Date(delivered),
        ),
        reason,
        executor: isOwner || !!worked,
      });
      if (kind === 'accepted') status = 'done';
      else {
        nextAction = `Corrigir: ${reason}`.slice(0, 2000);
        followUp = renewed();
      }
      break;
    }
    default:
      throw new InputError('Registro inválido');
  }
  const updated = await ctx.db.query(
    `UPDATE requests SET status=$3::text,next_action=COALESCE($4,next_action),follow_up_on=CASE WHEN $3::text='done' THEN NULL ELSE COALESCE($5::date,follow_up_on) END,version=version+1,updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING id,version,status`,
    [requestId, ctx.organizationId, status, nextAction, followUp],
  );
  // The trigger only sees columns it tracks; alerts must react to this row as well.
  await ctx.db.query(
    "INSERT INTO automation_jobs(organization_id,kind,request_id,dedupe_key) VALUES($1,'evaluate_request',$2,$3) ON CONFLICT DO NOTHING",
    [
      ctx.organizationId,
      requestId,
      `request:${requestId}:${updated.rows[0].version}`,
    ],
  );
  return updated.rows[0];
}

const trailLabels: Record<string, string> = {
  agreement: 'Combinado',
  confirmation: 'Cliente confirmou',
  risk_authorization: 'Alto risco autorizado',
  delivered: 'Entregue',
  accepted: 'Aceito',
  rejected: 'Recusado',
  closed_without_acceptance: 'Concluída sem aceite',
};
/** Every version and answer of one demand, oldest first, ready to read. */
export async function alignmentTrail(ctx: Context, requestId: string) {
  const { rows } = await ctx.db.query(
    `SELECT a.kind,a.agreement_version,a.criteria,a.high_risk,a.reason,i.summary evidence,a.recorded_by_executor,a.recorded_at,u.display_name recorded_by
 FROM request_alignment a JOIN users u ON u.id=a.recorded_by LEFT JOIN interactions i ON i.id=a.evidence_interaction_id AND i.organization_id=a.organization_id
 WHERE a.organization_id=$1 AND a.request_id=$2 ORDER BY a.recorded_at`,
    [ctx.organizationId, requestId],
  );
  return rows.map((a) => ({
    ...a,
    text: [
      dayText(a.recorded_at.toISOString().slice(0, 10)),
      a.recorded_by,
      trailLabels[a.kind] +
        (a.agreement_version ? ` v${a.agreement_version}` : ''),
      a.criteria,
      a.high_risk && 'Alto risco',
      a.reason,
      a.evidence && `Evidência: ${a.evidence}`,
      a.recorded_by_executor && 'Registrado por quem executou',
    ]
      .filter(Boolean)
      .join(' · '),
  }));
}
