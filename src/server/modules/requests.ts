import {
  InputError,
  text,
  uuid,
  status,
  transition,
} from '../../shared/domain';
import type { Status } from '../../shared/domain';
import { authorize, audit } from '../auth/policy';
import type { Context } from '../auth/policy';
import { HttpError } from '../errors';
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
  const result = await ctx.db.query(
    "INSERT INTO requests(id,organization_id,interaction_id,title,description,status,owner,owner_user_id,next_action) VALUES($1,$2,$3,$4,$5,'new',$6,$7,$8) RETURNING *",
    [
      id,
      ctx.organizationId,
      interactionId,
      text(body.title, 'Título'),
      text(body.description, 'Descrição', 10000),
      assigned.name,
      assigned.id,
      text(body.next_action, 'Próxima ação', 2000),
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
    }>(
      'SELECT status,version,owner_user_id FROM requests WHERE id=$1 AND organization_id=$2 FOR UPDATE',
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
  transition(current.status, next);
  const assigned = await owner(ctx, body.owner_user_id);
  const result = await ctx.db.query(
    'UPDATE requests SET status=$3,owner_user_id=$4,next_action=$5,version=version+1,updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING *',
    [requestId, ctx.organizationId, next, assigned.id, nextAction],
  );
  await audit(ctx, 'request', requestId, `${current.status}->${next};updated`);
  return { ...result.rows[0], owner: assigned.name };
}
