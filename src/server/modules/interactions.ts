import { InputError, text, uuid } from '../../shared/domain';
import { authorize, audit } from '../auth/policy';
import type { Context } from '../auth/policy';
import { HttpError } from '../errors';
export async function createInteraction(
  ctx: Context,
  body: Record<string, unknown>,
) {
  authorize(ctx, 'create');
  const id = crypto.randomUUID();
  const projectId = uuid(body.project_id);
  if (body.kind !== 'meeting' && body.kind !== 'service')
    throw new InputError('Tipo inválido');
  const occurred = text(body.occurred_at, 'Data', 50);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}.*(?:Z|[+-]\d{2}:\d{2})$/.test(occurred) ||
    !Number.isFinite(Date.parse(occurred))
  )
    throw new InputError('Data ISO com fuso horário obrigatória');
  if (
    !(
      await ctx.db.query(
        'SELECT 1 FROM projects WHERE id=$1 AND organization_id=$2',
        [projectId, ctx.organizationId],
      )
    ).rowCount
  )
    throw new HttpError(404, 'Projeto não encontrado');
  const result = await ctx.db.query(
    'INSERT INTO interactions(id,organization_id,project_id,kind,summary,occurred_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
    [
      id,
      ctx.organizationId,
      projectId,
      body.kind,
      text(body.summary, 'Resumo', 10000),
      occurred,
    ],
  );
  await audit(ctx, 'interaction', id, 'created');
  return result.rows[0];
}
