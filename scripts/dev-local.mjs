// `npm run dev:local`: PostgreSQL, permissions, migrations, API and Vite, with one command and
// no Docker. It only reuses what already exists: scripts/postgres.mjs, provision-roles,
// migrate, runtime.mjs (the same runtime role and checks as production) and Vite.
// Data stays in .local/postgres: nothing here deletes, resets or restores anything.
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseEnv } from 'node:util';
import pg from 'pg';
import {
  DevLocalError,
  cleanChildEnvironment,
  holderFromSs,
  parsePostmaster,
  portConflictMessage,
  validateDevEnvironment,
} from './lib/dev-local.mjs';

const PORTS = { db: 5432, api: 3000, web: 5173 };
const DATA_DIR = resolve('.local/postgres');
const PIDS = resolve('.local/dev-local.pids');
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
function portOpen(port) {
  return new Promise((done) => {
    const socket = connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => (socket.destroy(), done(true)));
    socket.once('error', () => done(false));
  });
}
function holderOf(port) {
  const r = spawnSync('ss', ['-ltnpH', `sport = :${port}`], {
    encoding: 'utf8',
  });
  return r.status === 0 ? holderFromSs(r.stdout) : undefined;
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
/** A process from an earlier run that lost its supervisor is ours only if it runs from here. */
function ownOrphan(pid) {
  if (!alive(pid)) return false;
  try {
    return readlinkSync(`/proc/${pid}/cwd`) === process.cwd();
  } catch {
    return false;
  }
}
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
/** Leftovers of a run killed with SIGKILL: API and Vite are stopped, the database is adopted. */
async function recoverOrphans() {
  if (!existsSync(PIDS)) return undefined;
  let saved = {};
  try {
    saved = JSON.parse(readFileSync(PIDS, 'utf8'));
  } catch {
    /* unreadable: treated as no leftovers */
  }
  if (saved.supervisor && ownOrphan(saved.supervisor))
    throw new DevLocalError(
      `O dev:local já está rodando neste checkout (pid ${saved.supervisor}). Use essa execução ou encerre-a com Ctrl+C.`,
    );
  for (const name of ['api', 'web'])
    if (saved[name] && ownOrphan(saved[name])) {
      say(
        `encerrando ${name} deixado por uma execução interrompida (pid ${saved[name]})`,
      );
      await stopGroup(saved[name], name);
    }
  rmSync(PIDS, { force: true });
  return saved.db && ownOrphan(saved.db) ? saved.db : undefined;
}
async function assertPortFree(port, what) {
  if (await portOpen(port))
    throw new DevLocalError(portConflictMessage(port, what, holderOf(port)));
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
/** The listener on 5432 may be reused only if it serves this checkout's .local/postgres. */
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
function prefixed(name, stream) {
  createInterface({ input: stream }).on('line', (line) =>
    console.log(`[${name}] ${line}`),
  );
}
function start(name, command, args, env) {
  const child = spawn(command, args, {
    env,
    detached: true, // own group: order and waiting at shutdown stay in our hands
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  prefixed(name, child.stdout);
  prefixed(name, child.stderr);
  children.push({ name, process: child });
  savePids();
  child.once('exit', (code, signal) => {
    if (!stopping) {
      console.error(
        `[dev] ${name} terminou sozinho (${signal ?? `código ${code}`}). Encerrando o restante; os dados continuam em .local/postgres.`,
      );
      void shutdown(1);
    }
  });
  return child;
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
  if (r.stdout.trim())
    console.log(`[db] ${r.stdout.trim().replaceAll('\n', '\n[db] ')}`);
  if (r.status !== 0) {
    const message = (r.stderr || r.stdout)
      .trim()
      .split('\n')
      .find((l) => /error/i.test(l));
    throw new DevLocalError(
      `${label} falhou: ${message ?? r.stderr.trim().slice(0, 400)}`,
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

async function main() {
  if (process.getuid?.() === 0)
    throw new DevLocalError(
      'Execute com seu usuário normal: o PostgreSQL recusa rodar como root.',
    );
  for (const tool of [BUN, resolve('node_modules/.bin/vite')])
    if (!existsSync(tool))
      throw new DevLocalError('Dependências ausentes: rode npm ci.');
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
  const roles = readEnvFile('.local/database.env');
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
  const adminUrl = fileEnv.DATABASE_URL;
  if (!adminUrl)
    throw new DevLocalError(
      'DATABASE_URL ausente no .env. Compare com .env.example.',
    );
  const base = cleanChildEnvironment(process.env);

  let adopted = await recoverOrphans();
  await assertPortFree(PORTS.api, 'a API');
  await assertPortFree(PORTS.web, 'o Vite');

  // ---- PostgreSQL: reuse this checkout's cluster if it is up, start it otherwise.
  if (await portOpen(PORTS.db)) {
    if (!(await isOurDatabase(adminUrl))) {
      const holder = holderOf(PORTS.db);
      throw new DevLocalError(
        `${portConflictMessage(PORTS.db, 'o PostgreSQL local', holder)} Ele não serve ${DATA_DIR}, então não foi usado.`,
      );
    }
    say(
      `reutilizando o PostgreSQL de .local/postgres, em 127.0.0.1:${PORTS.db}`,
    );
    if (adopted) {
      // Left by an interrupted run: stops with this one, as if it had started here.
      children.push({ name: 'db', process: { pid: adopted } });
      savePids();
    }
  } else {
    adopted = undefined;
    const lock = existsSync(`${DATA_DIR}/postmaster.pid`)
      ? parsePostmaster(readFileSync(`${DATA_DIR}/postmaster.pid`, 'utf8'))
      : undefined;
    if (lock && alive(lock.pid) && lock.port !== PORTS.db)
      throw new DevLocalError(
        `Já existe um PostgreSQL usando ${DATA_DIR} (pid ${lock.pid}) na porta ${lock.port}. Encerre-o com: kill ${lock.pid}`,
      );
    say(
      existsSync(`${DATA_DIR}/PG_VERSION`)
        ? 'iniciando o PostgreSQL de .local/postgres'
        : 'criando o PostgreSQL em .local/postgres',
    );
    start('db', process.execPath, ['scripts/postgres.mjs'], base);
    // scripts/postgres.mjs creates the database: "ready" means it is there.
    await waitUntil(
      () => isOurDatabase(adminUrl, 'catus'),
      'O PostgreSQL',
      60000,
    );
    if (stopping) return;
  }
  const admin = adminClient(adminUrl, 'postgres');
  await admin.connect();
  const exists = await admin.query(
    "SELECT 1 FROM pg_database WHERE datname='catus'",
  );
  // Only a reused cluster can lack it, for instance after an interrupted first start.
  if (!exists.rowCount) await admin.query('CREATE DATABASE catus');
  await admin.end();

  // ---- Permissions and migrations, both safe to repeat.
  step('A preparação das permissões', ['scripts/provision-roles.ts'], {
    ...base,
    DATABASE_URL: adminUrl,
  });
  const prepared = readEnvFile('.local/database.env');
  step('As migrations', ['scripts/migrate.ts'], { ...base, ...prepared });
  if (process.argv.includes('--prepare-only')) {
    say('banco pronto');
    return shutdown(0);
  }

  // ---- API (same launcher and checks as production) and Vite, both with hot reload.
  start('api', process.execPath, ['scripts/runtime.mjs', '--watch'], base);
  await waitUntil(
    () =>
      fetch(`http://127.0.0.1:${PORTS.api}/api/auth/config`).then(
        (r) => r.ok,
        () => false,
      ),
    'A API',
    30000,
  );
  start(
    'web',
    resolve('node_modules/.bin/vite'),
    ['--host', '127.0.0.1', '--port', String(PORTS.web), '--strictPort'],
    base,
  );
  await waitUntil(() => portOpen(PORTS.web), 'O Vite', 30000);
  if (stopping) return; // a child died while waiting: shutdown already explained why
  say(`pronto: ${settings.origin}`);
  say(
    settings.oidc
      ? 'login Google configurado. Primeiro acesso: npm run bootstrap:admin (docs/DEV_LOCAL.md)'
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
