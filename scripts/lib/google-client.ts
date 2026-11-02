/**
 * Validates Google OAuth "Web application" client settings before they are
 * written to the operator's protected files. Pure: no I/O, never echoes the secret.
 */
export const GOOGLE_ISSUER = 'https://accounts.google.com';
export interface GoogleClient {
  clientId: string;
  clientSecret: string;
  hostedDomain?: string;
}
const CLIENT_ID = /^[a-zA-Z0-9._-]+\.apps\.googleusercontent\.com$/;
const DOMAIN =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
// Consumer domains never carry the signed `hd` claim: restricting to them locks everyone out.
const CONSUMER = new Set(['gmail.com', 'googlemail.com']);

export function validateGoogleClient(input: {
  clientId?: unknown;
  clientSecret?: unknown;
  hostedDomain?: unknown;
}): GoogleClient {
  const clientId =
    typeof input.clientId === 'string' ? input.clientId.trim() : '';
  if (!CLIENT_ID.test(clientId))
    throw new Error(
      'Client ID inválido: esperado <id>.apps.googleusercontent.com',
    );
  const clientSecret =
    typeof input.clientSecret === 'string' ? input.clientSecret : '';
  if (!/^[\x21-\x7e]{8,256}$/.test(clientSecret))
    throw new Error(
      'Client secret ausente ou com formato inválido (sem espaços/quebras)',
    );
  const hd =
    typeof input.hostedDomain === 'string'
      ? input.hostedDomain.trim().toLowerCase()
      : '';
  if (hd && (!DOMAIN.test(hd) || CONSUMER.has(hd)))
    throw new Error(
      'Domínio Workspace inválido; deixe vazio para contas Google comuns',
    );
  return { clientId, clientSecret, ...(hd ? { hostedDomain: hd } : {}) };
}

/** Parses the JSON downloaded from Google Cloud ("Download JSON" of a Web client). */
export function parseGoogleClientJson(
  text: string,
  origin: string,
  hostedDomain?: string,
): GoogleClient {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Arquivo do cliente Google não é JSON válido');
  }
  const root = (data ?? {}) as Record<string, unknown>;
  if (!root.web)
    throw new Error(
      root.installed
        ? 'Cliente do tipo errado: crie um cliente "Aplicativo da Web"'
        : 'JSON sem a seção "web" de um cliente OAuth do Google',
    );
  const web = root.web as Record<string, unknown>;
  const redirect = `${origin}/api/auth/callback`;
  if (Array.isArray(web.redirect_uris) && !web.redirect_uris.includes(redirect))
    throw new Error(
      `URI de redirecionamento ausente no cliente Google: cadastre exatamente ${redirect}`,
    );
  if (
    web.auth_uri !== undefined &&
    !String(web.auth_uri).startsWith(GOOGLE_ISSUER + '/')
  )
    throw new Error('JSON não pertence ao Google Accounts');
  return validateGoogleClient({
    clientId: web.client_id,
    clientSecret: web.client_secret,
    hostedDomain,
  });
}

/** Non-secret runtime settings (Compose env_file). The secret goes to its own 0600 file. */
export function oidcEnvFile(client: GoogleClient) {
  return [
    `OIDC_ISSUER=${GOOGLE_ISSUER}`,
    `OIDC_CLIENT_ID=${client.clientId}`,
    ...(client.hostedDomain
      ? [`OIDC_HOSTED_DOMAIN=${client.hostedDomain}`]
      : []),
    '',
  ].join('\n');
}
