import type { Context } from './auth/policy';
import { HttpError } from './errors';
import { uuid } from '../shared/domain';
import { createHash } from 'node:crypto';
export const creationRoutes = [
  '/api/clients',
  '/api/projects',
  '/api/interactions',
  '/api/requests',
] as const;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
export async function reserveCreation(
  ctx: Context,
  path: string,
  key: string | null,
  body: Record<string, unknown>,
) {
  if (!key) throw new HttpError(400, 'Idempotency-Key UUID obrigatório');
  uuid(key);
  const digest = createHash('sha256').update(canonical(body)).digest('hex');
  const args = [ctx.organizationId, ctx.userId, path, key];
  // Unique key + conflict wait serializes concurrent retries across processes.
  const inserted = await ctx.db.query(
    'INSERT INTO idempotency_keys(organization_id,user_id,route,key,request_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING key',
    [...args, digest],
  );
  if (inserted.rowCount) return undefined;
  const row = (
    await ctx.db.query(
      'SELECT request_hash,response_status,response_body,expires_at FROM idempotency_keys WHERE organization_id=$1 AND user_id=$2 AND route=$3 AND key=$4 FOR UPDATE',
      args,
    )
  ).rows[0];
  if (!row || row.expires_at <= new Date())
    throw new HttpError(
      409,
      'Chave expirada; confira o registro e use uma nova chave',
    );
  if (row.request_hash !== digest)
    throw new HttpError(409, 'Chave já usada com outro conteúdo');
  if (!row.response_status)
    throw new HttpError(409, 'Operação ainda não concluída');
  return { body: row.response_body, status: row.response_status as number };
}
export async function completeCreation(
  ctx: Context,
  path: string,
  key: string,
  result: Response,
) {
  await ctx.db.query(
    'UPDATE idempotency_keys SET response_status=$5,response_body=$6 WHERE organization_id=$1 AND user_id=$2 AND route=$3 AND key=$4',
    [
      ctx.organizationId,
      ctx.userId,
      path,
      key,
      result.status,
      await result.clone().json(),
    ],
  );
}
