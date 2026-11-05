// `bun run dev:local`: PostgreSQL, permissions, migrations, API and Vite, with one command and
// no Docker. It only reuses what already exists: scripts/postgres.mjs, provision-roles,
// migrate, runtime.mjs (the same runtime role and checks as production) and Vite.
// Data stays in .local/postgres: nothing here deletes, resets or restores anything.
// A taken port is never a reason to touch whoever holds it: this run takes another one.
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseEnv } from 'node:util';
import pg from 'pg';
import {
  DevLocalError,
  PORT_RANGES,
  chooseFreePort,
  cleanChildEnvironment,
  databaseUrlAt,
  holderFromSs,
  hydrateEmbeddedPostgres,
  isOwnProcess,
  parsePostmaster,
  roleFileAtPort,
  validateDevEnvironment,
} from './lib/dev-local.mjs';

const HERE = process.cwd();
const DATA_DIR = resolve('.local/postgres');
const PIDS = resolve('.local/dev-local.pids');
const ROLES = '.local/database.env';
const BUN = resolve('node_modules/.bin/bun');
const children = [];
let stopping = false;
let ownsPids = false;

const say = (text) => console.log(`[dev] ${text}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readEnvFile = (file) =>
  existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** Free means this process can bind it on loopback, which a wildcard listener also prevents. */
function portFree(port) {
  return new Promise((done) => {
    const server = createServer();
    server.once('error', () => done(false));
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () =>
      server.close(() => done(true)),
    );
  });
}
function holderOf(port) {
  const r = spawnSync('ss', ['-ltnpH', `sport = :${port}`], {
    encoding: 'utf8',
  });
  return r.status === 0 ? holderFromSs(r.stdout) : undefined;
}
/** Picks a port and says why when it is not the usual one. Only ever reads who holds it. */
async function takePort(what, range, preferred, isFree = portFree) {
  const port = await chooseFreePort(preferred, range, isFree);
  if (port !== preferred[0]) {
    const holder = holderOf(preferred[0]);
    say(
      `porta ${preferred[0]} ocupada${holder ? ` por ${holder.name} (pid ${holder.pid})` : ''}; ${what} vai usar ${port}. Nada foi alterado nesse processo.`,
    );
  }
  return port;
}
function savePids() {
  ownsPids = true;
  writeFileSync(
    PIDS,
    JSON.stringify({
      supervisor: process.pid,
      ...Object.fromEntries(children.map((c) => [c.name, c.process.pid])),
    }),
    { mode: 0o600 },
  );
}
function ownOrphan(pid) {
  if (!Number.isInteger(pid) || !alive(pid)) return false;
  try {
    return isOwnProcess(
      {
        cwd: readlinkSync(`/proc/${pid}/cwd`),
        cmdline: readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll(
          '\0',
          ' ',
        ),
      },
      HERE,
    );
  } catch {
    return false;
  }
}
/** Signals only process groups this flow started, or verified as its own by ownOrphan. */
async function stopGroup(pid, label, waitMs = 8000) {
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    return;
  }
  const until = Date.now() + waitMs;
  while (alive(pid) && Date.now() < until) await sleep(100);
  if (alive(pid)) {
    if (label === 'db') {
      // PostgreSQL is never forced: a SIGKILL could leave recovery work for the next start.
      say(
        'PostgreSQL ainda está encerrando; ele termina sozinho, com os dados preservados.',
      );
      return;
    }
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}
/** Leftovers of a run killed outright: API and Vite are stopped, the database is adopted. */
async function recoverOrphans() {
  if (!existsSync(PIDS)) return undefined;
  let saved = {};
  try {
    saved = JSON.parse(readFileSync(PIDS, 'utf8'));
  } catch {
    /* unreadable: treated as no leftovers */
  }
  if (ownOrphan(saved.supervisor))
    throw new DevLocalError(
      `O dev:local já está rodando neste checkout (pid ${saved.supervisor}). Use essa execução ou encerre-a com Ctrl+C.`,
    );
  for (const name of ['api', 'web'])
    if (ownOrphan(saved[name])) {
      say(
        `encerrando ${name} deixado por uma execução interrompida (pid ${saved[name]})`,
      );
      await stopGroup(saved[name], name);
    }
  rmSync(PIDS, { force: true });
  return ownOrphan(saved.db) ? saved.db : undefined;
}
function adminClient(url, database) {
  const target = new URL(url);
  if (database) target.pathname = '/' + database;
  const client = new pg.Client({
    connectionString: target.href,
    connectionTimeoutMillis: 2000,
  });
  // A connection dropped while the server starts or stops is handled by whoever is waiting.
  client.on('error', () => undefined);
  return client;
}
/** Only a server that proves to serve this checkout's .local/postgres is ever reused. */
async function isOurDatabase(url, database = 'postgres') {
  const c = adminClient(url, database);
  try {
    await c.connect();
    const dir = (await c.query('SHOW data_directory')).rows[0].data_directory;
    return existsSync(DATA_DIR) && realpathSync(dir) === realpathSync(DATA_DIR);
  } catch {
    return false;
  } finally {
    await c.end().catch(() => undefined);
  }
}
/** The port of this checkout's PostgreSQL, if it is running. */
async function runningClusterPort(adminUrl) {
  const file = `${DATA_DIR}/postmaster.pid`;
  if (!existsSync(file)) return undefined;
  const lock = parsePostmaster(readFileSync(file, 'utf8'));
  if (!lock || !alive(lock.pid)) return undefined;
  if (await isOurDatabase(databaseUrlAt(adminUrl, lock.port))) return lock.port;
  let isPostgres = false;
  try {
    isPostgres = readFileSync(`/proc/${lock.pid}/cmdline`, 'utf8').includes(
      'postgres',
    );
  } catch {
    /* no /proc: decided by the connection above */
  }
  if (isPostgres)
    throw new DevLocalError(
      `O PostgreSQL de .local/postgres (pid ${lock.pid}, porta ${lock.port}) não aceitou a conexão. Confira DATABASE_URL no .env ou aguarde ele terminar de subir.`,
    );
  return undefined; // the pid was reused by another program: a stale lock
}
function prefixed(entry, stream) {
  createInterface({ input: stream }).on('line', (line) => {
    // Colors, if forced by the environment, must not hide the line we wait for.
    entry.log += line.replace(/\x1b\[[0-9;]*m/g, '') + '\n';
    console.log(`[${entry.name}] ${line}`);
  });
}
function start(name, command, args, env) {
  const child = spawn(command, args, {
    env,
    detached: true, // own group: order and waiting at shutdown stay in our hands
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const entry = { name, process: child, log: '', launching: false };
  prefixed(entry, child.stdout);
  prefixed(entry, child.stderr);
  children.push(entry);
  savePids();
  child.once('exit', (code, signal) => {
    entry.exited = true;
    if (!stopping && !entry.launching) {
      console.error(
        `[dev] ${name} terminou sozinho (${signal ?? `código ${code}`}). Encerrando o restante; os dados continuam em .local/postgres.`,
      );
      void shutdown(1);
    }
  });
  return entry;
}
/**
 * Starts a service and waits for its own "listening" line. Another program can take a port
 * after it was found free; that comes back as 'taken', so another port can be tried.
 */
async function launch(name, command, args, env, listening, ms = 30000) {
  const entry = start(name, command, args, env);
  entry.launching = true;
  const until = Date.now() + ms;
  while (Date.now() < until && !stopping) {
    if (listening.test(entry.log)) {
      entry.launching = false;
      if (entry.exited) break;
      return 'up';
    }
    if (/EADDRINUSE|already in use|in use\?/i.test(entry.log) || entry.exited)
      break;
    await sleep(100);
  }
  if (stopping) return 'up';
  const taken = /EADDRINUSE|already in use|in use\?/i.test(entry.log);
  await discard(entry);
  if (taken) return 'taken';
  throw new DevLocalError(
    entry.exited
      ? `${name} terminou ao iniciar. Veja as linhas acima.`
      : `${name} não respondeu em ${ms / 1000} s.`,
  );
}
async function discard(entry) {
  entry.launching = true;
  await stopGroup(entry.process.pid, entry.name);
  children.splice(children.indexOf(entry), 1);
  savePids();
}
async function shutdown(code) {
  if (stopping) return;
  stopping = true;
  say('encerrando; os dados continuam em .local/postgres');
  for (const c of [...children].reverse())
    await stopGroup(c.process.pid, c.name, c.name === 'db' ? 20000 : 8000);
  if (ownsPids) rmSync(PIDS, { force: true });
  process.exit(code);
}
function step(label, args, env) {
  const r = spawnSync(BUN, ['--no-env-file', ...args], {
    env,
    encoding: 'utf8',
  });
  if (r.stdout?.trim())
    console.log(`[db] ${r.stdout.trim().replaceAll('\n', '\n[db] ')}`);
  if (r.status !== 0) {
    const message = (r.stderr || r.stdout || '')
      .trim()
      .split('\n')
      .find((l) => /error/i.test(l));
    throw new DevLocalError(
      `${label} falhou: ${message ?? r.stderr?.trim().slice(0, 400) ?? r.error?.message}`,
    );
  }
}
async function waitUntil(check, what, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (stopping) return;
    if (await check()) return;
    await sleep(200);
  }
  throw new DevLocalError(`${what} não respondeu em ${ms / 1000} s.`);
}
/**
 * The bundled PostgreSQL only loads with the library links its postinstall creates. That one
 * package is trusted in package.json, but `bun install` skips the script on an existing
 * node_modules, so the links are completed here, confined to the package.
 */
function assertPostgresLoads() {
  const pkg = `@embedded-postgres/${process.platform}-${process.arch}`;
  const dir = resolve(`node_modules/${pkg}`);
  const binary = `${dir}/native/bin/postgres`;
  if (!existsSync(binary))
    throw new DevLocalError(
      `PostgreSQL embarcado ausente para esta máquina (${pkg}). Rode: bun install --frozen-lockfile`,
    );
  const loads = () => spawnSync(binary, ['--version'], { encoding: 'utf8' });
  let r = loads();
  const trusted = JSON.parse(
    readFileSync('package.json', 'utf8'),
  ).trustedDependencies?.includes(pkg);
  if (r.status !== 0 && trusted) {
    say(
      `completando ${hydrateEmbeddedPostgres(dir)} links de biblioteca do PostgreSQL embarcado`,
    );
    r = loads();
  }
  if (r.status !== 0)
    throw new DevLocalError(
      `O PostgreSQL embarcado não carrega: ${(r.stderr || '').trim().slice(0, 200)} Veja docs/DEV_LOCAL.md.`,
    );
}
/** Same credentials, new port, without a window in which the file is half written. */
function alignRoleFile(port) {
  if (!existsSync(ROLES)) return;
  const text = readFileSync(ROLES, 'utf8');
  const next = roleFileAtPort(text, port);
  if (next === text) return;
  writeFileSync(`${ROLES}.tmp`, next, { mode: 0o600 });
  renameSync(`${ROLES}.tmp`, ROLES);
}

async function main() {
  if (process.getuid?.() === 0)
    throw new DevLocalError(
      'Execute com seu usuário normal: o PostgreSQL recusa rodar como root.',
    );
  for (const tool of [BUN, resolve('node_modules/.bin/vite')])
    if (!existsSync(tool))
      throw new DevLocalError(
        'Dependências ausentes: rode bun install --frozen-lockfile.',
      );
  mkdirSync('.local', { recursive: true, mode: 0o700 });
  if (!existsSync('.env')) {
    const r = spawnSync(process.execPath, ['scripts/init-env.mjs'], {
      stdio: 'inherit',
    });
    if (r.status !== 0)
      throw new DevLocalError('Não foi possível criar o .env.');
  }
  chmodSync('.env', 0o600);
  const fileEnv = readEnvFile('.env');
  const roles = readEnvFile(ROLES);
  const shell = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => k.includes('DATABASE') && k.endsWith('_URL'),
    ),
  );
  const settings = validateDevEnvironment([
    fileEnv,
    roles,
    shell,
    { NODE_ENV: process.env.NODE_ENV },
  ]);
  if (!fileEnv.DATABASE_URL)
    throw new DevLocalError(
      'DATABASE_URL ausente no .env. Compare com .env.example.',
    );
  assertPostgresLoads();
  const base = cleanChildEnvironment(process.env);

  const adopted = await recoverOrphans();

  // ---- PostgreSQL: this checkout's cluster if it is up, started otherwise.
  const usualDbPort = Number(new URL(fileEnv.DATABASE_URL).port || 5432);
  let dbPort = await runningClusterPort(fileEnv.DATABASE_URL);
  if (dbPort) {
    say(`reutilizando o PostgreSQL de .local/postgres, na porta ${dbPort}`);
    if (adopted) {
      // Left by an interrupted run: stops with this one, as if it had started here.
      children.push({ name: 'db', process: { pid: adopted } });
      savePids();
    }
  } else {
    dbPort = await takePort('o PostgreSQL', PORT_RANGES.db, [
      usualDbPort,
      ...(roles.RUNTIME_DATABASE_URL
        ? [Number(new URL(roles.RUNTIME_DATABASE_URL).port || 5432)]
        : []),
    ]);
    say(
      existsSync(`${DATA_DIR}/PG_VERSION`)
        ? 'iniciando o PostgreSQL de .local/postgres'
        : 'criando o PostgreSQL em .local/postgres',
    );
    start('db', process.execPath, ['scripts/postgres.mjs'], {
      ...base,
      CATUS_DB_PORT: String(dbPort),
    });
    // scripts/postgres.mjs creates the database: "ready" means it is there.
    await waitUntil(
      () => isOurDatabase(databaseUrlAt(fileEnv.DATABASE_URL, dbPort), 'catus'),
      'O PostgreSQL',
      60000,
    );
    if (stopping) return;
  }
  const adminUrl = databaseUrlAt(fileEnv.DATABASE_URL, dbPort);
  const admin = adminClient(adminUrl, 'postgres');
  await admin.connect();
  const exists = await admin.query(
    "SELECT 1 FROM pg_database WHERE datname='catus'",
  );
  // Only a reused cluster can lack it, for instance after an interrupted first start.
  if (!exists.rowCount) await admin.query('CREATE DATABASE catus');
  await admin.end();

  // ---- Permissions and migrations, both safe to repeat.
  alignRoleFile(dbPort);
  step('A preparação das permissões', ['scripts/provision-roles.ts'], {
    ...base,
    DATABASE_URL: adminUrl,
  });
  step('As migrations', ['scripts/migrate.ts'], {
    ...base,
    ...readEnvFile(ROLES),
  });
  if (process.argv.includes('--prepare-only')) {
    say('banco pronto');
    return shutdown(0);
  }

  // ---- API (same launcher and checks as production) and Vite, both with hot reload.
  const taken = new Set();
  const free = async (port) => !taken.has(port) && (await portFree(port));
  let apiPort, webPort, origin;
  for (let attempt = 1; ; attempt++) {
    if (attempt > 5)
      throw new DevLocalError(
        'As portas continuam sendo ocupadas assim que ficam livres. Tente de novo em instantes.',
      );
    webPort = await takePort(
      'o Vite',
      PORT_RANGES.web,
      [settings.webPort],
      free,
    );
    apiPort = await takePort(
      'a API',
      PORT_RANGES.api,
      [settings.apiPort],
      free,
    );
    origin = `http://${settings.host}:${webPort}`;
    const api = await launch(
      'api',
      process.execPath,
      ['scripts/runtime.mjs', '--watch'],
      { ...base, PORT: String(apiPort), APP_ORIGIN: origin },
      /Catus listening on loopback port/,
    );
    if (api === 'taken') {
      taken.add(apiPort);
      continue;
    }
    const web = await launch(
      'web',
      resolve('node_modules/.bin/vite'),
      ['--host', '127.0.0.1', '--port', String(webPort), '--strictPort'],
      { ...base, CATUS_DEV_API_PORT: String(apiPort) },
      /ready in \d+/,
    );
    if (web === 'up') break;
    // The API was told this origin, so it starts again with the next one.
    taken.add(webPort);
    await discard(children.find((c) => c.name === 'api'));
  }
  if (stopping) return; // a child died while waiting: shutdown already explained why
  say(`pronto: ${origin}`);
  say(`API na porta ${apiPort}; PostgreSQL na porta ${dbPort}`);
  if (settings.oidc && webPort !== settings.webPort)
    say(
      `ATENÇÃO: o Vite não está na porta de sempre. Para o login Google funcionar, cadastre também ${origin}/api/auth/callback no cliente de desenvolvimento.`,
    );
  say(
    settings.oidc
      ? 'login Google configurado. Primeiro acesso: bun run bootstrap:admin (docs/DEV_LOCAL.md)'
      : 'login desligado: sem OIDC no .env. Para configurar: docs/DEV_LOCAL.md',
  );
  say('Ctrl+C encerra tudo e preserva os dados');
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
  process.on(signal, () => void shutdown(0));
main().catch(async (e) => {
  console.error(
    `[dev] ${e instanceof DevLocalError ? e.message : `erro inesperado: ${e?.stack ?? e}`}`,
  );
  await shutdown(1);
});
