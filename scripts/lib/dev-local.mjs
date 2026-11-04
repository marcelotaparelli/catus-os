// Pure rules of `npm run dev:local`, separate so they can be tested without a database.
const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]', '::1'];

export class DevLocalError extends Error {}

/** Any database URL this flow may touch must be on this machine and be a Catus one. */
export function assertLocalDatabaseUrl(name, value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new DevLocalError(`${name} não é uma URL válida.`);
  }
  if (!LOOPBACK.includes(url.hostname))
    throw new DevLocalError(
      `${name} aponta para ${url.hostname}. O dev:local só usa o banco desta máquina e não acessa banco remoto nem de produção.`,
    );
  if (!/^\/(catus|[a-z][a-z0-9_]*_test)$/.test(url.pathname))
    throw new DevLocalError(
      `${name} usa o banco ${url.pathname.slice(1)}. O dev:local só usa catus e bancos *_test locais.`,
    );
}

/** Checks everything before anything starts. `sources` are the files and the process environment. */
export function validateDevEnvironment(sources) {
  for (const source of sources)
    for (const [key, value] of Object.entries(source))
      if (key.includes('DATABASE') && key.endsWith('_URL') && value)
        assertLocalDatabaseUrl(key, value);
  const env = Object.assign({}, ...sources);
  if (env.NODE_ENV === 'production')
    throw new DevLocalError(
      'NODE_ENV=production não combina com dev:local. Remova a variável para desenvolver.',
    );
  const origin = env.APP_ORIGIN ?? 'http://127.0.0.1:5173';
  if (!['http://127.0.0.1:5173', 'http://localhost:5173'].includes(origin))
    throw new DevLocalError(
      `APP_ORIGIN=${origin}. O dev:local usa http://127.0.0.1:5173, porque o Vite atende nessa porta e encaminha /api.`,
    );
  if ((env.PORT ?? '3000') !== '3000')
    throw new DevLocalError(
      `PORT=${env.PORT}. O dev:local usa a API na porta 3000, para onde o Vite encaminha /api.`,
    );
  if (env.TLS_CERT_FILE || env.TLS_KEY_FILE)
    throw new DevLocalError(
      'TLS_CERT_FILE e TLS_KEY_FILE são de homologação. Remova-os do .env para desenvolver em http.',
    );
  const oidc = ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET'].filter(
    (k) => env[k],
  );
  if (oidc.length && oidc.length < 3)
    throw new DevLocalError(
      'OIDC incompleto no .env: informe OIDC_ISSUER, OIDC_CLIENT_ID e OIDC_CLIENT_SECRET, ou nenhum. Veja docs/DEV_LOCAL.md.',
    );
  return { origin, oidc: oidc.length === 3 };
}

/** Environment for child processes: never carries database URLs or tokens of the shell. */
export function cleanChildEnvironment(base) {
  const env = { ...base };
  for (const key of Object.keys(env))
    if (
      (key.includes('DATABASE') && key.endsWith('_URL')) ||
      ['PGPASSWORD', 'PGPASSFILE', 'PGHOST', 'PGDATABASE', 'PGUSER'].includes(
        key,
      )
    )
      delete env[key];
  return env;
}

/** `ss -ltnpH` output to the process holding a port, when the system says. */
export function holderFromSs(output) {
  const match = /users:\(\("([^"]+)",pid=(\d+)/.exec(output);
  return match ? { name: match[1], pid: Number(match[2]) } : undefined;
}

export function portConflictMessage(port, what, holder) {
  const who = holder ? `${holder.name} (pid ${holder.pid})` : 'outro processo';
  const hint = holder
    ? `Encerre esse processo, se puder, com: kill ${holder.pid}`
    : `Descubra qual é com: ss -ltnp 'sport = :${port}'`;
  return `A porta ${port}, usada por ${what}, está ocupada por ${who}. ${hint}`;
}

/** Reads a postmaster.pid: line 1 is the pid, line 2 the data directory, line 4 the port. */
export function parsePostmaster(text) {
  const lines = text.split('\n');
  const pid = Number(lines[0]);
  const port = Number(lines[3]);
  return Number.isInteger(pid) && pid > 0
    ? { pid, dataDir: lines[1], port }
    : undefined;
}
