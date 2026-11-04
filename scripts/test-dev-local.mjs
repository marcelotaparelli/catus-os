// End-to-end check of `npm run dev:local` without Docker. Runs in a disposable copy of the
// repository, so the developer's .env and .local/postgres are never touched. Needs ports
// 3000, 5173 and 5432 free, and a non-root user.
import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  appendFileSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { createServer, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parseEnv } from 'node:util';
import pg from 'pg';

const source = process.cwd();
const dir = mkdtempSync(
  join(process.env.DEV_LOCAL_TMP ?? tmpdir(), 'catus-dev-local-'),
);
for (const entry of [
  'scripts',
  'src',
  'db',
  'index.html',
  'vite.config.ts',
  'svelte.config.js',
  'tsconfig.json',
  'package.json',
])
  cpSync(join(source, entry), join(dir, entry), { recursive: true });
symlinkSync(resolve(source, 'node_modules'), join(dir, 'node_modules'));

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` (${detail})` : ''}`,
  );
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const portOpen = (port) =>
  new Promise((done) => {
    const s = connect({ port, host: '127.0.0.1' });
    s.once('connect', () => (s.destroy(), done(true)));
    s.once('error', () => done(false));
  });
for (const port of [3000, 5173, 5432])
  if (await portOpen(port)) {
    console.error(
      `Porta ${port} ocupada: libere 3000, 5173 e 5432 para este teste.`,
    );
    process.exit(2);
  }
function run(env = {}) {
  const child = spawn(process.execPath, ['scripts/dev-local.mjs'], {
    cwd: dir,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { child, out: '', exited: false, code: undefined };
  child.stdout.on('data', (d) => (state.out += d));
  child.stderr.on('data', (d) => (state.out += d));
  child.once('exit', (code) => Object.assign(state, { exited: true, code }));
  return state;
}
async function until(fn, label, ms = 90000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(100);
  }
  console.log(`      tempo esgotado: ${label}`);
  return false;
}
const ready = (s) =>
  until(() => s.out.includes('[dev] pronto') || s.exited, 'pronto');
const finish = (s) => until(() => s.exited, 'encerrar', 40000);
function occupy(port) {
  return new Promise((done) => {
    const server = createServer();
    server.listen(port, '127.0.0.1', () => done(server));
  });
}
const admin = () =>
  new pg.Client({
    connectionString: 'postgres://catus:catus_local_only@127.0.0.1:5432/catus',
  });
async function query(sql) {
  const c = admin();
  await c.connect();
  try {
    return (await c.query(sql)).rows;
  } finally {
    await c.end();
  }
}
const sha = (file) =>
  createHash('sha256')
    .update(readFileSync(join(dir, file)))
    .digest('hex');

// ---- Refusals happen before anything starts.
for (const [label, env, expected] of [
  [
    'banco remoto na variável de ambiente',
    { DATABASE_URL: 'postgres://u:p@db.exemplo.com:5432/catus' },
    'aponta para db.exemplo.com',
  ],
  [
    'URL de runtime remota',
    { RUNTIME_DATABASE_URL: 'postgres://u:p@10.0.0.9/catus' },
    'aponta para 10.0.0.9',
  ],
  [
    'banco local com outro nome',
    { MIGRATION_DATABASE_URL: 'postgres://u:p@127.0.0.1/producao' },
    'usa o banco producao',
  ],
  ['NODE_ENV=production', { NODE_ENV: 'production' }, 'NODE_ENV=production'],
]) {
  const s = run(env);
  await finish(s);
  check(s.code === 1 && s.out.includes(expected), `recusa: ${label}`);
}
check(!(await portOpen(5432)), 'nenhuma recusa iniciou o PostgreSQL');

// ---- Port conflicts name the port and leave nothing running.
for (const [port, what] of [
  [3000, 'a API'],
  [5173, 'o Vite'],
]) {
  const server = await occupy(port);
  const s = run();
  await finish(s);
  check(
    s.code === 1 &&
      s.out.includes(`A porta ${port}, usada por ${what}, está ocupada`),
    `conflito na porta ${port} explicado`,
  );
  server.close();
  await sleep(100);
}
{
  const server = await occupy(5432);
  const s = run();
  await finish(s);
  check(
    s.code === 1 &&
      s.out.includes('A porta 5432') &&
      s.out.includes('não foi usado'),
    'outro serviço na 5432 não é usado',
  );
  server.close();
  await sleep(100);
}
check(
  !(await portOpen(3000)) && !(await portOpen(5173)),
  'conflitos não deixam processos',
);

// ---- First run: everything from one command, and no secret readable by others.
let s = run();
check(
  (await ready(s)) && !s.exited,
  'primeira execução fica pronta',
  s.exited ? s.out.slice(-400) : '',
);
const page = await fetch('http://127.0.0.1:5173/').then(
  (r) => r.status,
  () => 0,
);
check(page === 200, 'Vite responde');
const proxied = await fetch('http://127.0.0.1:5173/api/auth/config').then(
  (r) => r.json(),
  () => ({}),
);
check(
  proxied.configured === false,
  'Vite encaminha /api para a API; login desligado sem OIDC',
);
const session = await fetch('http://127.0.0.1:5173/api/session').then(
  (r) => r.status,
  () => 0,
);
check(
  session === 503 || session === 401,
  'autenticação de produção continua valendo',
  String(session),
);
check((statSync(join(dir, '.env')).mode & 0o077) === 0, '.env só para o dono');
check(
  (statSync(join(dir, '.local/database.env')).mode & 0o077) === 0,
  '.local/database.env só para o dono',
);
const migrations = await query('SELECT count(*)::int n FROM schema_migrations');
check(
  migrations[0].n ===
    spawnSync('ls', ['db/migrations'], { cwd: dir, encoding: 'utf8' })
      .stdout.trim()
      .split('\n').length,
  'todas as migrations aplicadas',
);
const roles = parseEnv(readFileSync(join(dir, '.local/database.env'), 'utf8'));
const runtime = new pg.Client({ connectionString: roles.RUNTIME_DATABASE_URL });
await runtime.connect();
const su = (
  await runtime.query(
    'SELECT rolsuper,rolcreatedb FROM pg_roles WHERE rolname=current_user',
  )
).rows[0];
await runtime.end();
check(
  su.rolsuper === false && su.rolcreatedb === false,
  'API usa o papel de runtime, sem privilégios',
);
const apiEnv = spawnSync(
  'sh',
  [
    '-c',
    "cat /proc/$(ss -ltnpH 'sport = :3000' | sed -n 's/.*pid=\\([0-9]*\\).*/\\1/p' | head -1)/environ | tr '\\0' '\\n' | cut -d= -f1",
  ],
  { encoding: 'utf8' },
).stdout;
check(
  apiEnv === '' ||
    (!/^DATABASE_URL$/m.test(apiEnv) &&
      !/^MIGRATION_DATABASE_URL$/m.test(apiEnv)),
  'API sem credenciais administrativas no ambiente',
  apiEnv === '' ? 'ss indisponível' : '',
);

// ---- Hot reload of both sides.
const startsBefore = s.out.match(/Catus listening/g)?.length ?? 0;
appendFileSync(join(dir, 'src/server/config.ts'), '\n// recarga de teste\n');
check(
  await until(
    () => (s.out.match(/Catus listening/g)?.length ?? 0) > startsBefore,
    'recarga da API',
    20000,
  ),
  'API recarrega ao salvar',
);
appendFileSync(
  join(dir, 'src/web/routes.ts'),
  '\nexport const marcaDeTeste = 1;\n',
);
check(
  await until(
    () =>
      fetch('http://127.0.0.1:5173/src/web/routes.ts')
        .then((r) => r.text())
        .then(
          (t) => t.includes('marcaDeTeste'),
          () => false,
        ),
    'recarga do Vite',
    20000,
  ),
  'Vite serve a alteração ao salvar',
);

// ---- A second run cannot disturb the first.
{
  const second = run();
  await finish(second);
  check(
    second.code === 1 && second.out.includes('já está rodando neste checkout'),
    'segunda execução recusada',
  );
  check(
    (await portOpen(3000)) && (await portOpen(5173)) && !s.exited,
    'primeira execução segue de pé',
  );
}

// ---- Data written now must survive everything below.
const org = '00000000-0000-4000-8000-000000000001';
await query(
  `INSERT INTO clients(id,organization_id,name) VALUES('00000000-0000-4000-8000-00000000dead','${org}','Marca de persistência')`,
);
const hashBefore = sha('.local/database.env');

// ---- Ctrl+C: all children gone, in order, exit 0.
s.child.kill('SIGINT');
await finish(s);
check(s.code === 0, 'Ctrl+C encerra com sucesso', String(s.code));
await sleep(300);
check(
  !(await portOpen(3000)) && !(await portOpen(5173)) && !(await portOpen(5432)),
  'API, Vite e PostgreSQL encerrados',
);

// ---- Second run: same data, same credentials, nothing reapplied.
s = run();
check((await ready(s)) && !s.exited, 'segunda execução fica pronta');
check(!s.out.includes('Applied '), 'nenhuma migration reaplicada');
check(!s.out.includes('criando o PostgreSQL'), 'cluster reutilizado');
check(sha('.local/database.env') === hashBefore, 'credenciais preservadas');
check(
  (
    await query(
      "SELECT count(*)::int n FROM clients WHERE name='Marca de persistência'",
    )
  )[0].n === 1,
  'dados preservados em .local/postgres',
);

// ---- SIGTERM behaves the same.
s.child.kill('SIGTERM');
await finish(s);
check(s.code === 0 && !(await portOpen(3000)), 'SIGTERM encerra tudo');
await sleep(500);

// ---- Supervisor killed outright: next run recovers without manual commands.
s = run();
await ready(s);
s.child.kill('SIGKILL');
await sleep(500);
check(await portOpen(3000), 'SIGKILL deixa a API órfã (cenário preparado)');
s = run();
check(
  (await ready(s)) && !s.exited,
  'execução seguinte recupera os órfãos',
  s.exited ? s.out.slice(-300) : '',
);
check(
  s.out.includes('deixado por uma execução interrompida') &&
    s.out.includes('reutilizando o PostgreSQL'),
  'encerra API e Vite órfãos e reaproveita o banco',
);
check(
  (
    await query(
      "SELECT count(*)::int n FROM clients WHERE name='Marca de persistência'",
    )
  )[0].n === 1,
  'dados preservados após SIGKILL',
);
s.child.kill('SIGINT');
await finish(s);
await sleep(500);
check(!(await portOpen(5432)), 'banco adotado encerra junto');

// ---- A child that dies stops the rest with a clear message.
s = run();
await ready(s);
const pids = JSON.parse(
  readFileSync(join(dir, '.local/dev-local.pids'), 'utf8'),
);
process.kill(-pids.web, 'SIGKILL');
await finish(s);
check(
  s.code === 1 && s.out.includes('web terminou sozinho'),
  'falha de um processo encerra o restante, com aviso',
);
await sleep(500);
check(
  !(await portOpen(3000)) && !(await portOpen(5432)),
  'nada fica para trás',
);

// ---- --prepare-only and the database stopped afterwards.
{
  const p = spawnSync(
    process.execPath,
    ['scripts/dev-local.mjs', '--prepare-only'],
    { cwd: dir, encoding: 'utf8' },
  );
  check(
    p.status === 0 && p.stdout.includes('banco pronto'),
    '--prepare-only prepara o banco e sai',
    p.stderr.slice(0, 200),
  );
  check(!(await portOpen(5432)), '--prepare-only não deixa o banco de pé');
}
// ---- With OIDC in .env: login turns on, and the documented first-administrator command works.
// Nothing reaches Google here: discovery only happens when someone clicks to log in.
appendFileSync(
  join(dir, '.env'),
  'OIDC_ISSUER=https://accounts.google.com\nOIDC_CLIENT_ID=dev-teste\nOIDC_CLIENT_SECRET=dev-teste\n',
);
s = run();
check((await ready(s)) && !s.exited, 'com OIDC no .env, fica pronto');
const configured = await fetch('http://127.0.0.1:5173/api/auth/config').then(
  (r) => r.json(),
  () => ({}),
);
check(configured.configured === true, 'login ligado pelo .env');
check(
  s.out.includes('npm run bootstrap:admin'),
  'indica o comando do primeiro administrador',
);
const bootstrap = spawnSync(
  'npm',
  [
    'run',
    '--silent',
    'bootstrap:admin',
    '--',
    '--email',
    'admin@exemplo.test',
    '--name',
    'Admin Dev',
  ],
  { cwd: dir, encoding: 'utf8' },
);
check(
  bootstrap.status === 0,
  'bootstrap:admin funciona com o banco do dev:local',
  (bootstrap.stderr || bootstrap.stdout).trim().slice(0, 240),
);
const admins = await query(
  "SELECT count(*)::int n FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.email='admin@exemplo.test' AND m.role='administrator'",
);
check(admins[0].n === 1, 'administrador autorizado');
s.child.kill('SIGINT');
await finish(s);
check(s.code === 0, 'encerra com OIDC ligado');
console.log(
  failures
    ? `\n${failures} falha(s). Cópia preservada em ${dir}`
    : `\nTudo certo. Cópia descartável em ${dir}`,
);
process.exit(failures ? 1 : 0);
