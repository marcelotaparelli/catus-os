// Rules of `bun run dev:local`, separate so they can be tested without a database.
import { existsSync, lstatSync, readFileSync, symlinkSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]', '::1'];

export class DevLocalError extends Error {}

const validPort = (port) =>
  Number.isInteger(port) && port >= 1024 && port <= 65535;

/** Where each service may go when its port is taken. Loopback only, and never overlapping. */
export const PORT_RANGES = {
  api: [3001, 3099],
  web: [5174, 5199],
  db: [5433, 5499],
};

/** The first free port: the preferred ones in order, then the service's own range. */
export async function chooseFreePort(preferred, [from, to], isFree) {
  const seen = new Set();
  for (const port of preferred)
    if (validPort(port) && !seen.has(port)) {
      seen.add(port);
      if (await isFree(port)) return port;
    }
  for (let port = from; port <= to; port++)
    if (!seen.has(port) && (await isFree(port))) return port;
  throw new DevLocalError(
    `Nenhuma porta livre entre ${from} e ${to}. Libere alguma e tente de novo.`,
  );
}

/** The same credentials on another local port. The password and the role never change. */
export function databaseUrlAt(value, port) {
  const url = new URL(value);
  url.port = String(port);
  return url.href;
}

/** A role file with its database URLs moved to `port`; every other line stays as it is. */
export function roleFileAtPort(text, port) {
  return text
    .split('\n')
    .map((line) => {
      const match = /^([A-Z_]*DATABASE_URL)=(.+)$/.exec(line);
      return match ? `${match[1]}=${databaseUrlAt(match[2], port)}` : line;
    })
    .join('\n');
}

/** A process of an earlier run is ours only if it runs from here and is one of our programs. */
export function isOwnProcess({ cwd, cmdline }, here) {
  return (
    cwd === here &&
    /(scripts\/dev-local\.mjs|scripts\/postgres\.mjs|scripts\/runtime\.mjs|src\/server\/index\.ts|node_modules\/\.bin\/vite|\/vite\b)/.test(
      cmdline,
    )
  );
}

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
  const parsed = /^http:\/\/(127\.0\.0\.1|localhost):(\d+)$/.exec(origin);
  if (!parsed || !validPort(Number(parsed[2])))
    throw new DevLocalError(
      `APP_ORIGIN=${origin}. O dev:local usa http neste computador, como http://127.0.0.1:5173.`,
    );
  const apiPort = Number(env.PORT ?? 3000);
  if (!validPort(apiPort))
    throw new DevLocalError(
      `PORT=${env.PORT}. Use uma porta entre 1024 e 65535; o dev:local só escuta neste computador.`,
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
  return {
    host: parsed[1],
    webPort: Number(parsed[2]),
    apiPort,
    oidc: oidc.length === 3,
  };
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

/** Reads a postmaster.pid: line 1 is the pid, line 2 the data directory, line 4 the port. */
export function parsePostmaster(text) {
  const lines = text.split('\n');
  const pid = Number(lines[0]);
  const port = Number(lines[3]);
  return Number.isInteger(pid) && pid > 0
    ? { pid, dataDir: lines[1], port }
    : undefined;
}

/**
 * Does what the postinstall of @embedded-postgres does, from the list that package ships:
 * relative links to its own libraries. No third-party code runs, nothing leaves native/,
 * and existing files are left alone. Needed because `bun install` skips the script when
 * node_modules already exists. Returns how many links were created.
 */
export function hydrateEmbeddedPostgres(packageDir) {
  const list = JSON.parse(
    readFileSync(resolve(packageDir, 'native/pg-symlinks.json'), 'utf8'),
  );
  const root = resolve(packageDir, 'native') + sep;
  let created = 0;
  for (const { source, target } of list) {
    const from = resolve(packageDir, source),
      to = resolve(packageDir, target);
    if (!from.startsWith(root) || !to.startsWith(root))
      throw new DevLocalError(
        `Lista de links do PostgreSQL embarcado aponta para fora do pacote: ${target}`,
      );
    if (!existsSync(from)) continue;
    try {
      lstatSync(to);
      continue;
    } catch {
      symlinkSync(relative(dirname(to), from), to);
      created++;
    }
  }
  return created;
}
