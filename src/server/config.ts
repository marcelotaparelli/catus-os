import { clickupOrganization } from './clickup/config';
export interface AppConfig {
  origin: string;
  secureCookies: boolean;
  /** Set only when ClickUp is enabled: the single tenant that may read it. */
  clickupOrganizationId?: string;
  oidc?: {
    issuer: string;
    clientId: string;
    clientSecret: string;
    hostedDomain?: string;
  };
}
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): AppConfig {
  const origin = env.APP_ORIGIN ?? 'http://127.0.0.1:5173';
  const url = new URL(origin);
  if (url.origin !== origin || url.username || url.password)
    throw new Error('APP_ORIGIN must be an exact origin');
  const secureCookies = url.protocol === 'https:';
  if (
    !secureCookies &&
    (url.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      env.NODE_ENV === 'production')
  )
    throw new Error('HTTPS required except loopback development');
  const supplied = [
    env.OIDC_ISSUER,
    env.OIDC_CLIENT_ID,
    env.OIDC_CLIENT_SECRET,
  ];
  if (supplied.some(Boolean) && !supplied.every(Boolean))
    throw new Error('Incomplete OIDC configuration');
  const clickupOrganizationId = clickupOrganization(env);
  const base = {
    origin,
    secureCookies,
    ...(clickupOrganizationId ? { clickupOrganizationId } : {}),
  };
  if (!supplied.every(Boolean)) return base;
  const issuer = new URL(env.OIDC_ISSUER!);
  if (
    issuer.protocol !== 'https:' ||
    issuer.username ||
    issuer.password ||
    issuer.search ||
    issuer.hash
  )
    throw new Error('OIDC issuer must use HTTPS');
  return {
    ...base,
    oidc: {
      issuer: env.OIDC_ISSUER!,
      clientId: env.OIDC_CLIENT_ID!,
      clientSecret: env.OIDC_CLIENT_SECRET!,
      ...(env.OIDC_HOSTED_DOMAIN
        ? { hostedDomain: env.OIDC_HOSTED_DOMAIN }
        : {}),
    },
  };
}
