/** Test-only simulated provider. All ID tokens are actually signed and validated by openid-client. */
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { createHash } from 'node:crypto';
import type { CustomFetch } from 'openid-client';
import type { AppConfig } from '../../src/server/config';
export const config: AppConfig = {
  origin: 'http://127.0.0.1:5173',
  secureCookies: false,
  oidc: {
    issuer: 'https://oidc.test',
    clientId: 'catus-test',
    clientSecret: 'test-only-secret',
    hostedDomain: 'catus.test',
  },
};
export interface TestCode {
  email: string;
  sub?: string;
  nonce: string;
  challenge: string;
  failure?:
    | 'nonce'
    | 'signature'
    | 'audience'
    | 'issuer'
    | 'expired'
    | 'email'
    | 'domain'
    | 'subject'
    // Consumer Google account (gmail.com): valid token without the `hd` claim.
    | 'consumer';
}
export function codeFor(
  authorization: URL,
  email: string,
  failure?: TestCode['failure'],
) {
  return Buffer.from(
    JSON.stringify({
      email,
      nonce: authorization.searchParams.get('nonce'),
      challenge: authorization.searchParams.get('code_challenge'),
      failure,
    }),
  ).toString('base64url');
}
export async function mockOidcFetch(): Promise<CustomFetch> {
  const keys = await generateKeyPair('RS256');
  const other = await generateKeyPair('RS256');
  const jwk = await exportJWK(keys.publicKey);
  return async (input, options) => {
    const url = new URL(String(input));
    if (url.href === 'https://oidc.test/.well-known/openid-configuration')
      return Response.json({
        issuer: 'https://oidc.test',
        authorization_endpoint: 'https://oidc.test/authorize',
        token_endpoint: 'https://oidc.test/token',
        jwks_uri: 'https://oidc.test/jwks',
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
      });
    if (url.href === 'https://oidc.test/jwks')
      return Response.json({
        keys: [{ ...jwk, kid: 'test', alg: 'RS256', use: 'sig' }],
      });
    if (url.href !== 'https://oidc.test/token')
      throw new Error('Unexpected test provider URL');
    const params = new URLSearchParams(String(options?.body));
    const data = JSON.parse(
      Buffer.from(params.get('code') ?? '', 'base64url').toString(),
    ) as TestCode;
    if (
      createHash('sha256')
        .update(params.get('code_verifier') ?? '')
        .digest('base64url') !== data.challenge
    )
      return Response.json({ error: 'invalid_grant' }, { status: 400 });
    const token = await new SignJWT({
      email: data.email,
      email_verified: data.failure !== 'email',
      nonce: data.failure === 'nonce' ? 'wrong' : data.nonce,
      ...(data.failure === 'consumer'
        ? {}
        : { hd: data.failure === 'domain' ? 'other.test' : 'catus.test' }),
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setIssuer(
        data.failure === 'issuer' ? 'https://evil.test' : 'https://oidc.test',
      )
      .setAudience(data.failure === 'audience' ? 'other' : 'catus-test')
      .setSubject(
        data.failure === 'subject'
          ? 'different-subject'
          : (data.sub ?? `sub:${data.email}`),
      )
      .setIssuedAt()
      .setExpirationTime(data.failure === 'expired' ? '0s' : '5m')
      .sign(data.failure === 'signature' ? other.privateKey : keys.privateKey);
    return Response.json({
      access_token: 'test-access',
      token_type: 'Bearer',
      id_token: token,
      expires_in: 300,
    });
  };
}
