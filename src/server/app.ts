import { pool } from './db';
import { InputError, uuid } from '../shared/domain';
import { HttpError } from './errors';
import type { AppConfig } from './config';
import { loadConfig } from './config';
import type { OidcProvider } from './auth/oidc';
import { authRoute, oidcProvider } from './auth/oidc';
import {
  authenticate,
  sessionView,
  verifyCsrf,
  issueSession,
} from './auth/session';
import { audit, authorize } from './auth/policy';
import { cookie } from './auth/cookies';
import { extractionCapability } from './extraction';
import {
  getMissionControl,
  getMembers,
  getAudit,
} from './modules/mission-control';
import { createClient } from './modules/clients';
import { createProject } from './modules/projects';
import { createInteraction } from './modules/interactions';
import { createRequest, updateRequest } from './modules/requests';
import { provisionMember, revokeMember } from './modules/memberships';
function response(
  data: unknown,
  code = 200,
  extra: Record<string, string> = {},
) {
  return Response.json(data, {
    status: code,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      ...extra,
    },
  });
}
async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.startsWith('application/json'))
    throw new HttpError(415, 'Use application/json');
  // Stream limit prevents oversized bodies even when Content-Length is absent or forged.
  const reader = request.body?.getReader();
  if (!reader) throw new InputError('Corpo obrigatório');
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 32768) {
        await reader.cancel();
        throw new HttpError(413, 'Corpo muito grande');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString());
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error();
    body = parsed as Record<string, unknown>;
  } catch {
    throw new InputError('JSON inválido');
  }

  return body;
}
export function createApp(
  config: AppConfig = loadConfig(),
  provider: OidcProvider | undefined = oidcProvider(config),
) {
  return async (request: Request): Promise<Response> => {
    let db;
    try {
      db = await pool.connect();
    } catch {
      return response({ error: 'Serviço temporariamente indisponível' }, 503);
    }
    try {
      await db.query('BEGIN');
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method;
      const origin = request.headers.get('origin');
      if (origin && origin !== config.origin)
        throw new HttpError(403, 'Origem não permitida');
      let result: Response;
      if (method === 'GET' && path === '/api/auth/config')
        result = response({ configured: !!provider });
      else if (
        method === 'GET' &&
        ['/api/auth/login', '/api/auth/callback'].includes(path)
      )
        result = await authRoute(db, request, config, provider);
      else {
        if (!provider)
          throw new HttpError(
            503,
            'OIDC não configurado; autenticação bloqueada',
          );
        const ctx = await authenticate(db, request, config);
        authorize(ctx, 'read');
        if (!['GET', 'POST', 'PATCH'].includes(method))
          throw new HttpError(404, 'Rota não encontrada');
        if (method !== 'GET') verifyCsrf(request, ctx, config);
        if (method === 'GET') {
          switch (path) {
            case '/api/health':
              await db.query('SELECT 1');
              result = response({ status: 'ok' });
              break;
            case '/api/session':
              result = response(await sessionView(ctx));
              break;
            case '/api/members':
              result = response(await getMembers(ctx));
              break;
            case '/api/audit':
              result = response(await getAudit(ctx));
              break;
            case '/api/mission-control':
              result = response(await getMissionControl(ctx));
              break;
            case '/api/extraction':
              result = response(extractionCapability);
              break;
            default:
              throw new HttpError(404, 'Rota não encontrada');
          }
        } else {
          const body = await readBody(request);
          // Identity, tenant and actor always come from server-side session and membership.
          for (const key of [
            'organization_id',
            'actor',
            'actor_user_id',
            'user_id',
            'role',
          ])
            if (
              key in body &&
              path !== '/api/session/organization' &&
              path !== '/api/memberships'
            )
              throw new InputError('Campo de identidade não permitido');
          if (method === 'POST') {
            switch (path) {
              case '/api/clients':
                result = response(await createClient(ctx, body), 201);
                break;
              case '/api/projects':
                result = response(await createProject(ctx, body), 201);
                break;
              case '/api/interactions':
                result = response(await createInteraction(ctx, body), 201);
                break;
              case '/api/requests':
                result = response(await createRequest(ctx, body), 201);
                break;
              case '/api/memberships':
                result = response(
                  await provisionMember(ctx, body, config.oidc?.issuer),
                  201,
                );
                break;
              case '/api/session/logout':
              case '/api/session/revoke-all':
                await db.query(
                  path.endsWith('revoke-all')
                    ? 'UPDATE sessions SET revoked_at=now() WHERE user_id=$1'
                    : 'UPDATE sessions SET revoked_at=now() WHERE id=$1',
                  [path.endsWith('revoke-all') ? ctx.userId : ctx.sessionId],
                );
                await audit(
                  ctx,
                  'session',
                  ctx.sessionId,
                  path.endsWith('revoke-all') ? 'revoked-all' : 'logout',
                );
                result = response({ status: 'ok' }, 200, {
                  'Set-Cookie': cookie(config, 'session', '', 0),
                });
                break;
              case '/api/session/organization': {
                const org = uuid(body.organization_id);
                if (
                  !(
                    await db.query(
                      'SELECT 1 FROM memberships WHERE user_id=$1 AND organization_id=$2 AND active FOR SHARE',
                      [ctx.userId, org],
                    )
                  ).rowCount
                )
                  throw new HttpError(403, 'Organização não autorizada');
                await db.query(
                  'UPDATE sessions SET revoked_at=now() WHERE id=$1',
                  [ctx.sessionId],
                );
                await audit(
                  ctx,
                  'session',
                  ctx.sessionId,
                  'organization-switched',
                );
                const session = await issueSession(db, ctx.userId, org);
                await audit(
                  { ...ctx, organizationId: org },
                  'session',
                  session.id,
                  'organization-entered',
                );
                result = response({ status: 'ok' }, 200, {
                  'Set-Cookie': cookie(config, 'session', session.token, 28800),
                });
                break;
              }
              default: {
                const revoke = /^\/api\/memberships\/([^/]+)\/revoke$/.exec(
                  path,
                );
                if (!revoke) throw new HttpError(404, 'Rota não encontrada');
                result = response(await revokeMember(ctx, revoke[1]!));
              }
            }
          } else {
            const match = /^\/api\/requests\/([^/]+)$/.exec(path);
            if (!match) throw new HttpError(404, 'Rota não encontrada');
            result = response(await updateRequest(ctx, match[1]!, body));
          }
        }
      }
      result.headers.set('Cache-Control', 'no-store');
      result.headers.set('Referrer-Policy', 'no-referrer');
      result.headers.set('X-Content-Type-Options', 'nosniff');
      result.headers.set('X-Frame-Options', 'DENY');
      await db.query('COMMIT');
      return result;
    } catch (e) {
      await db.query('ROLLBACK');
      if (e instanceof HttpError) return response({ error: e.message }, e.code);
      if (e instanceof InputError) return response({ error: e.message }, 422);
      const code = (e as { code?: string }).code;
      if (['23503', '23514'].includes(code ?? ''))
        return response({ error: 'Vínculo ou valor inválido' }, 422);
      if (code === '23505')
        return response(
          { error: 'Conflito de cadastro; recarregue e tente novamente' },
          409,
        );
      if (code === '22007' || code === '22008')
        return response({ error: 'Data inválida' }, 422);
      console.error('API failure', code ?? 'internal');
      return response({ error: 'Falha interna; tente novamente' }, 500);
    } finally {
      db.release();
    }
  };
}
