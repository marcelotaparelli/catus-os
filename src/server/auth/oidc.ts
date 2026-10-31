import * as client from 'openid-client';
import type { PoolClient } from 'pg';
import type { AppConfig } from '../config';
import { HttpError } from '../errors';
import {
  cookie,
  cookieName,
  hash,
  randomToken,
  readCookie,
  same,
} from './cookies';
import { issueSession } from './session';
export interface VerifiedIdentity {
  issuer: string;
  subject: string;
  email: string;
}
export interface OidcProvider {
  authorization(state: string, nonce: string, verifier: string): Promise<URL>;
  exchange(
    url: URL,
    state: string,
    nonce: string,
    verifier: string,
  ): Promise<VerifiedIdentity>;
}
/** Uses discovery and signature/issuer/audience/expiry/nonce verification from openid-client. */
export function oidcProvider(
  config: AppConfig,
  customFetch?: client.CustomFetch,
): OidcProvider | undefined {
  const oidc = config.oidc;
  if (!oidc) return undefined;
  let cached: Promise<client.Configuration> | undefined;
  function get() {
    return (cached ??= client
      .discovery(
        new URL(oidc!.issuer),
        oidc!.clientId,
        { client_secret: oidc!.clientSecret, [client.clockTolerance]: 0 },
        client.ClientSecretPost(oidc!.clientSecret),
        {
          timeout: 10,
          execute: [client.enableNonRepudiationChecks],
          ...(customFetch ? { [client.customFetch]: customFetch } : {}),
        },
      )
      .catch((e) => {
        cached = undefined;
        throw e;
      }));
  }
  return {
    async authorization(state, nonce, verifier) {
      return client.buildAuthorizationUrl(await get(), {
        redirect_uri: `${config.origin}/api/auth/callback`,
        scope: 'openid email profile',
        response_type: 'code',
        state,
        nonce,
        code_challenge: await client.calculatePKCECodeChallenge(verifier),
        code_challenge_method: 'S256',
        ...(oidc.hostedDomain ? { hd: oidc.hostedDomain } : {}),
      });
    },
    async exchange(url, state, nonce, verifier) {
      const tokens = await client.authorizationCodeGrant(await get(), url, {
        pkceCodeVerifier: verifier,
        expectedState: state,
        expectedNonce: nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (
        !claims ||
        claims.email_verified !== true ||
        typeof claims.email !== 'string' ||
        !claims.sub ||
        !claims.email.includes('@') ||
        claims.email.length > 254 ||
        (oidc.hostedDomain && claims.hd !== oidc.hostedDomain)
      )
        throw new HttpError(401, 'Identidade não verificada');
      return {
        issuer: oidc.issuer,
        subject: claims.sub,
        email: claims.email.toLowerCase(),
      };
    },
  };
}
function redirect(config: AppConfig, location: string, headers: Headers) {
  headers.set('location', location);
  return new Response(null, { status: 303, headers });
}
export async function authRoute(
  db: PoolClient,
  request: Request,
  config: AppConfig,
  provider: OidcProvider | undefined,
): Promise<Response> {
  if (!provider)
    throw new HttpError(503, 'OIDC não configurado; autenticação bloqueada');
  const url = new URL(request.url);
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  });
  if (url.pathname === '/api/auth/login') {
    const state = randomToken(),
      nonce = randomToken(),
      verifier = client.randomPKCECodeVerifier();
    const location = await provider.authorization(state, nonce, verifier);
    await db.query('DELETE FROM oidc_transactions WHERE expires_at<now()');
    await db.query(
      'INSERT INTO oidc_transactions(state_hash,nonce,verifier) VALUES($1,$2,$3)',
      [hash(state), nonce, verifier],
    );
    headers.append('Set-Cookie', cookie(config, 'oidc', state, 600));
    return redirect(config, location.href, headers);
  }
  const state = url.searchParams.get('state') ?? '';
  if (!state || !same(state, readCookie(request, cookieName(config, 'oidc'))))
    throw new HttpError(401, 'Retorno OIDC inválido');
  const transaction = (
    await db.query(
      'DELETE FROM oidc_transactions WHERE state_hash=$1 AND expires_at>now() RETURNING nonce,verifier',
      [hash(state)],
    )
  ).rows[0];
  if (!transaction)
    throw new HttpError(401, 'Retorno OIDC expirado ou reutilizado');
  // On provider rejection consume transaction anyway (the caller commits a controlled failure).
  let identity: VerifiedIdentity;
  try {
    identity = await provider.exchange(
      new URL(`${config.origin}/api/auth/callback${url.search}`),
      state,
      transaction.nonce,
      transaction.verifier,
    );
  } catch {
    headers.append('Set-Cookie', cookie(config, 'oidc', '', 0));
    return new Response(JSON.stringify({ error: 'Identidade OIDC recusada' }), {
      status: 401,
      headers,
    });
  }
  const user = (
    await db.query(
      'SELECT id,subject,active,display_name FROM users WHERE issuer=$1 AND (subject=$2 OR (subject IS NULL AND email=$3)) ORDER BY (subject=$2) DESC NULLS LAST LIMIT 1 FOR UPDATE',
      [identity.issuer, identity.subject, identity.email],
    )
  ).rows[0];
  if (!user || !user.active)
    return Response.json(
      { error: 'Usuário não provisionado' },
      { status: 403, headers },
    );
  const membership = (
    await db.query(
      'SELECT organization_id FROM memberships WHERE user_id=$1 AND active ORDER BY organization_id FOR SHARE',
      [user.id],
    )
  ).rows[0];
  if (!membership)
    return Response.json(
      { error: 'Sem organização autorizada' },
      { status: 403, headers },
    );
  if (!user.subject)
    await db.query('UPDATE users SET subject=$2 WHERE id=$1', [
      user.id,
      identity.subject,
    ]);
  // Revoke the presented session to prevent fixation while allowing other devices.
  const previous = readCookie(request, cookieName(config, 'session'));
  if (previous)
    await db.query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1', [
      hash(previous),
    ]);
  const session = await issueSession(db, user.id, membership.organization_id);
  await db.query(
    "INSERT INTO audit_events(organization_id,actor_user_id,actor,entity_type,entity_id,action) VALUES($1,$2,$3,'session',$4,'login')",
    [membership.organization_id, user.id, user.display_name, session.id],
  );
  headers.append('Set-Cookie', cookie(config, 'session', session.token, 28800));
  headers.append('Set-Cookie', cookie(config, 'oidc', '', 0));
  return redirect(config, config.origin + '/', headers);
}
