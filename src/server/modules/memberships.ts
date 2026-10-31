import { roles } from '../../shared/identity';
import { text, uuid, InputError } from '../../shared/domain';
import { authorize, audit } from '../auth/policy';
import type { Context } from '../auth/policy';
import { HttpError } from '../errors';
export async function provisionMember(
  ctx: Context,
  body: Record<string, unknown>,
  issuer: string | undefined,
) {
  authorize(ctx, 'admin');
  if (!issuer) throw new HttpError(503, 'OIDC não configurado');
  if (!roles.includes(body.role as (typeof roles)[number]))
    throw new InputError('Papel inválido');
  const email = text(body.email, 'Email', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new InputError('Email inválido');
  const name = text(body.name, 'Nome');
  // Serialize org administration. Never expose whether a user exists in another organization.
  await ctx.db.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [
    ctx.organizationId,
  ]);
  let user = (
    await ctx.db.query('SELECT id FROM users WHERE issuer=$1 AND email=$2', [
      issuer,
      email,
    ])
  ).rows[0];
  if (user?.id === ctx.userId)
    throw new HttpError(403, 'Não é permitido alterar seu próprio papel');
  if (!user)
    user = (
      await ctx.db.query(
        'INSERT INTO users(id,issuer,email,display_name) VALUES($1,$2,$3,$4) RETURNING id',
        [crypto.randomUUID(), issuer, email, name],
      )
    ).rows[0];
  await ctx.db.query(
    'INSERT INTO memberships(user_id,organization_id,role) VALUES($1,$2,$3) ON CONFLICT(user_id,organization_id) DO UPDATE SET role=excluded.role,active=true',
    [user.id, ctx.organizationId, body.role],
  );
  await audit(ctx, 'membership', user.id, `provisioned:${body.role}`);
  return { status: 'provisioned' };
}
export async function revokeMember(ctx: Context, id: string) {
  authorize(ctx, 'admin');
  uuid(id);
  if (id === ctx.userId)
    throw new HttpError(403, 'Não é permitido revogar a si mesmo');
  await ctx.db.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [
    ctx.organizationId,
  ]);
  if (
    !(
      await ctx.db.query(
        'UPDATE memberships SET active=false WHERE user_id=$1 AND organization_id=$2 AND active RETURNING user_id',
        [id, ctx.organizationId],
      )
    ).rowCount
  )
    throw new HttpError(404, 'Membro não encontrado');
  await ctx.db.query(
    'UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND organization_id=$2 AND revoked_at IS NULL',
    [id, ctx.organizationId],
  );
  await audit(ctx, 'membership', id, 'revoked');
  return { status: 'revoked' };
}
