import type { AppConfig } from './config';
/** Offline checks only. Never treats a configured client as evidence of Google authorization. */
export function validateGoogleProfile(config: AppConfig) {
  if (!config.secureCookies) throw new Error('Homologation requires HTTPS');
  if (!config.oidc || config.oidc.issuer !== 'https://accounts.google.com')
    throw new Error('Google issuer must be https://accounts.google.com');
  if (
    !/^[a-zA-Z0-9._-]+\.apps\.googleusercontent\.com$/.test(
      config.oidc.clientId,
    )
  )
    throw new Error('Google Web Application client ID required');
  if (
    !config.oidc.hostedDomain ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(
      config.oidc.hostedDomain,
    )
  )
    throw new Error('Workspace hd domain required for homologation');
  return {
    redirectUri: config.origin + '/api/auth/callback',
    issuer: config.oidc.issuer,
    hostedDomain: config.oidc.hostedDomain,
  };
}
