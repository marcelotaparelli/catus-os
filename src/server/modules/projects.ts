import { text, uuid } from '../../shared/domain';
import { authorize, audit } from '../auth/policy';
import type { Context } from '../auth/policy';
import { HttpError } from '../errors';
export async function createProject(
  ctx: Context,
  body: Record<string, unknown>,
) {
  authorize(ctx, 'create');
  const id = crypto.randomUUID();
  const clientId = uuid(body.client_id);
  if (
    !(
      await ctx.db.query(
        'SELECT 1 FROM clients WHERE id=$1 AND organization_id=$2',
        [clientId, ctx.organizationId],
      )
    ).rowCount
  )
    throw new HttpError(404, 'Cliente não encontrado');
  const result = await ctx.db.query(
    'INSERT INTO projects(id,organization_id,client_id,name) VALUES($1,$2,$3,$4) RETURNING *',
    [id, ctx.organizationId, clientId, text(body.name, 'Nome')],
  );
  await audit(ctx, 'project', id, 'created');
  return result.rows[0];
}
