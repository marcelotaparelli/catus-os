import type { PoolClient } from 'pg';
import type { AppConfig } from '../config';
import type { Context } from './policy';
import { HttpError } from '../errors';
import { cookieName, readCookie, hash, randomToken, same } from './cookies';
export async function issueSession(
  db: PoolClient,
  userId: string,
  organizationId: string,
) {
  const token = randomToken();
  const id = crypto.randomUUID();
  const csrf = randomToken();
  await db.query(
    'INSERT INTO sessions(id,token_hash,csrf_token,user_id,organization_id) VALUES($1,$2,$3,$4,$5)',
    [id, hash(token), csrf, userId, organizationId],
  );
  return { token, id };
}
export async function authenticate(
  db: PoolClient,
  request: Request,
  config: AppConfig,
): Promise<Context> {
  const token = readCookie(request, cookieName(config, 'session'));
  if (!/^[A-Za-z0-9_-]{43}$/.test(token))
    throw new HttpError(401, 'Sessão obrigatória');
  const row = (
    await db.query(
      `SELECT s.id session_id,s.csrf_token,s.expires_at,u.id user_id,u.email,u.display_name,m.organization_id,m.role
 FROM sessions s JOIN users u ON u.id=s.user_id JOIN memberships m ON m.user_id=u.id AND m.organization_id=s.organization_id
 WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND s.last_seen_at>now()-interval '30 minutes' AND u.active AND m.active AND u.issuer=$2 FOR UPDATE OF s FOR SHARE OF u,m`,
      [hash(token), config.oidc?.issuer ?? ''],
    )
  ).rows[0];
  if (!row) throw new HttpError(401, 'Sessão expirada ou revogada');
  await db.query(
    "UPDATE sessions SET last_seen_at=now() WHERE id=$1 AND last_seen_at<now()-interval '1 minute'",
    [row.session_id],
  );
  return {
    db,
    userId: row.user_id,
    organizationId: row.organization_id,
    role: row.role,
    name: row.display_name,
    email: row.email,
    sessionId: row.session_id,
    csrfToken: row.csrf_token,
    expiresAt: row.expires_at,
  };
}
export function verifyCsrf(request: Request, ctx: Context, config: AppConfig) {
  if (
    request.headers.get('origin') !== config.origin ||
    !same(request.headers.get('x-csrf-token') ?? '', ctx.csrfToken)
  )
    throw new HttpError(403, 'Verificação CSRF inválida');
}
export async function sessionView(ctx: Context) {
  const organizations = (
    await ctx.db.query(
      'SELECT o.id,o.name FROM organizations o JOIN memberships m ON m.organization_id=o.id WHERE m.user_id=$1 AND m.active ORDER BY o.name,o.id',
      [ctx.userId],
    )
  ).rows;
  const organization = organizations.find((o) => o.id === ctx.organizationId);
  return {
    user: { id: ctx.userId, name: ctx.name, email: ctx.email },
    organization,
    role: ctx.role,
    csrfToken: ctx.csrfToken,
    expiresAt: ctx.expiresAt.toISOString(),
    organizations,
  };
}
