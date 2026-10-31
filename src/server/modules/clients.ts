import { text } from '../../shared/domain';
import { authorize, audit } from '../auth/policy';
import type { Context } from '../auth/policy';
export async function createClient(
  ctx: Context,
  body: Record<string, unknown>,
) {
  authorize(ctx, 'create');
  const id = crypto.randomUUID();
  const result = await ctx.db.query(
    'INSERT INTO clients(id,organization_id,name) VALUES($1,$2,$3) RETURNING *',
    [id, ctx.organizationId, text(body.name, 'Nome')],
  );
  await audit(ctx, 'client', id, 'created');
  return result.rows[0];
}
