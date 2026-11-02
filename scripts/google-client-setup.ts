/**
 * Writes Google OIDC settings into the operator secret directory (no network).
 *   with /run/oidc/client.json mounted: reads the JSON downloaded from Google Cloud
 *   otherwise: reads stdin lines "client id", "client secret", "workspace domain or empty"
 * Outputs: <dir>/oidc.env (non-secret, 0600) and <dir>/oidc_client_secret (0600).
 * Never prints the secret.
 */
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import {
  parseGoogleClientJson,
  validateGoogleClient,
  oidcEnvFile,
} from './lib/google-client';
const dir = process.env.OIDC_OUTPUT_DIR ?? '/app/.local';
const origin = process.env.APP_ORIGIN;
const json = process.env.OIDC_CLIENT_JSON ?? '/run/oidc/client.json';
try {
  if (!origin?.startsWith('https://'))
    throw new Error('APP_ORIGIN HTTPS obrigatório');
  let client;
  if (existsSync(json))
    client = parseGoogleClientJson(
      readFileSync(json, 'utf8'),
      origin,
      process.env.OIDC_HOSTED_DOMAIN,
    );
  else {
    const [clientId, clientSecret, hostedDomain] = readFileSync(0, 'utf8')
      .split('\n')
      .map((l) => l.replace(/\r$/, ''));
    client = validateGoogleClient({ clientId, clientSecret, hostedDomain });
  }
  const write = (name: string, content: string) => {
    writeFileSync(`${dir}/${name}.tmp`, content, { mode: 0o600 });
    chmodSync(`${dir}/${name}.tmp`, 0o600);
    renameSync(`${dir}/${name}.tmp`, `${dir}/${name}`);
  };
  write('oidc_client_secret', client.clientSecret);
  write('oidc.env', oidcEnvFile(client));
  console.log(
    `Google OIDC salvo: client ${client.clientId}, ${client.hostedDomain ? `restrito ao Workspace ${client.hostedDomain}` : 'contas Google comuns (acesso só por convite)'}; segredo não exibido`,
  );
  console.log(`Redirect URI exigida no Google: ${origin}/api/auth/callback`);
} catch (e) {
  console.error(
    e instanceof Error ? e.message : 'Configuração Google inválida',
  );
  process.exitCode = 2;
}
