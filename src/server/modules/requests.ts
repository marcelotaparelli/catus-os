import {
  InputError,
  text,
  uuid,
  status,
  transition,
} from '../../shared/domain';
import type { Status } from '../../shared/domain';
import {
  defaultFollowUp,
  templateIds,
  waitingLabels,
} from '../../shared/followup';
import type { TemplateId, WaitingOn } from '../../shared/followup';
import { authorize, audit } from '../auth/policy';
import type { Context } from '../auth/policy';
import { HttpError } from '../errors';
const utcToday = () => new Date().toISOString().slice(0, 10);
/** A commitment is a calendar day from today on; a past date would be born overdue. */
function followUp(value: unknown): string {
  const day = typeof value === 'string' ? value : '';
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day
  )
    throw new InputError('Compromisso: informe uma data válida');
  if (day < utcToday())
    throw new InputError('Compromisso: a data não pode estar no passado');
  return day;
}
async function owner(ctx: Context, value: unknown) {
  const id = uuid(value);
  const user = (
    await ctx.db.query(
      'SELECT u.display_name FROM users u JOIN memberships m ON m.user_id=u.id WHERE u.id=$1 AND m.organization_id=$2 AND u.active AND m.active FOR SHARE OF u,m',
      [id, ctx.organizationId],
    )
  ).rows[0];
  if (!user)
    throw new HttpError(422, 'Responsável não disponível nesta organização');
  return { id, name: user.display_name as string };
}
export async function createRequest(
  ctx: Context,
  body: Record<string, unknown>,
) {
  authorize(ctx, 'create');
  const id = crypto.randomUUID();
  const interactionId = uuid(body.interaction_id);
  if (
    !(
      await ctx.db.query(
        'SELECT 1 FROM interactions WHERE id=$1 AND organization_id=$2',
        [interactionId, ctx.organizationId],
      )
    ).rowCount
  )
    throw new HttpError(404, 'Atendimento não encontrado');
  const assigned = await owner(ctx, body.owner_user_id);
  if (
    body.template !== undefined &&
    !templateIds.includes(body.template as TemplateId)
  )
    throw new InputError('Modelo de demanda inválido');
  const template = (body.template ?? 'manutencao') as TemplateId;
  const result = await ctx.db.query(
    "INSERT INTO requests(id,organization_id,interaction_id,title,description,status,owner,owner_user_id,next_action,template,follow_up_on) VALUES($1,$2,$3,$4,$5,'new',$6,$7,$8,$9,$10) RETURNING *",
    [
      id,
      ctx.organizationId,
      interactionId,
      text(body.title, 'Título'),
      text(body.description, 'Descrição', 10000),
      assigned.name,
      assigned.id,
      text(body.next_action, 'Próxima ação', 2000),
      template,
      body.follow_up_on === undefined
        ? defaultFollowUp(utcToday(), template)
        : followUp(body.follow_up_on),
    ],
  );
  await audit(ctx, 'request', id, 'created');
  return result.rows[0];
}
export async function updateRequest(
  ctx: Context,
  id: string,
  body: Record<string, unknown>,
) {
  authorize(ctx, 'update');
  const requestId = uuid(id);
  const next = status(body.status);
  const nextAction = text(body.next_action, 'Próxima ação', 2000);
  if (!Number.isSafeInteger(body.version) || Number(body.version) < 1)
    throw new InputError('Versão obrigatória');
  const current = (
    await ctx.db.query<{
      status: Status;
      version: number;
      owner_user_id: string | null;
      template: TemplateId | null;
      follow_up_on: string | null;
      blocked_reason: string | null;
      waiting_on: WaitingOn | null;
    }>(
      'SELECT status,version,owner_user_id,template,follow_up_on::text,blocked_reason,waiting_on FROM requests WHERE id=$1 AND organization_id=$2 FOR UPDATE',
      [requestId, ctx.organizationId],
    )
  ).rows[0];
  if (!current) throw new HttpError(404, 'Solicitação não encontrada');
  if (
    ctx.role === 'developer' &&
    (current.owner_user_id !== ctx.userId ||
      body.owner_user_id !== ctx.userId ||
      !['in_progress', 'blocked', 'done', current.status].includes(next))
  )
    throw new HttpError(
      403,
      'Desenvolvedor só pode executar solicitações atribuídas a si, sem reatribuir',
    );
  if (current.version !== body.version)
    throw new HttpError(409, 'Solicitação alterada; recarregue os dados');
  // A maintenance demand needs no separate triage step. A developer still cannot use this.
  if (
    !(
      current.status === 'new' &&
      next === 'ready' &&
      current.template === 'manutencao'
    )
  )
    transition(current.status, next);
  const assigned = await owner(ctx, body.owner_user_id);
  const today = utcToday(),
    moved = current.status !== next;
  let commitment = current.follow_up_on;
  if (body.follow_up_on !== undefined) commitment = followUp(body.follow_up_on);
  else if (moved && (!commitment || commitment < today))
    commitment = defaultFollowUp(today, current.template);
  let reason: string | null = null,
    waiting: WaitingOn | null = null;
  if (next === 'blocked') {
    // Nobody blocks work without saying why, and on whom it depends.
    reason = text(
      body.blocked_reason ?? current.blocked_reason,
      'Motivo do bloqueio',
      2000,
    );
    waiting = (body.waiting_on ?? current.waiting_on) as WaitingOn;
    if (!(waiting in waitingLabels))
      throw new InputError('Informe de quem o bloqueio depende');
  }
  if (next === 'done') commitment = null;
  const result = await ctx.db.query(
    'UPDATE requests SET status=$3,owner_user_id=$4,next_action=$5,follow_up_on=$6,blocked_reason=$7,waiting_on=$8,version=version+1,updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING *',
    [
      requestId,
      ctx.organizationId,
      next,
      assigned.id,
      nextAction,
      commitment,
      reason,
      waiting,
    ],
  );
  await audit(ctx, 'request', requestId, `${current.status}->${next};updated`);
  return { ...result.rows[0], owner: assigned.name };
}
