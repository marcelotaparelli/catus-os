// End-to-end check of `bun run dev:local` without Docker. Runs in a disposable copy of the
// repository, so the developer's .env and .local/postgres are never touched. Listeners that
// stand for other programs are real processes, and must survive every scenario untouched.
// Needs ports 3000, 5173 and 5432 free (the test occupies them itself), and a non-root user.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

// A docker that leaves a mark if anything ever calls it.
const shim = join(dir, '.shim');
mkdirSync(shim);
const dockerMark = join(dir, '.docker-was-called');
writeFileSync(
  join(shim, 'docker'),
  `#!/bin/sh\ntouch "${dockerMark}"\nexit 1\n`,
);
chmodSync(join(shim, 'docker'), 0o755);
const PATH = `${shim}:${process.env.PATH}`;
const BUN = resolve(source, 'node_modules/.bin/bun');

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` (${detail})` : ''}`,
  );
  if (!ok) failures++;
};
const section = (title) => console.log(`\n## ${title}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const portOpen = (port) =>
  new Promise((done) => {
    const s = connect({ port, host: '127.0.0.1' });
    s.once('connect', () => (s.destroy(), done(true)));
    s.once('error', () => done(false));
  });
for (const port of [3000, 3001, 5173, 5174, 5432, 5433])
  if (await portOpen(port)) {
    console.error(`Porta ${port} ocupada: este teste precisa dela livre.`);
    process.exit(2);
  }

/** A real listener in its own process, standing for a VM: not ours to touch. */
async function foreign(port) {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `require('net').createServer().listen(${port},'127.0.0.1');process.on('SIGTERM',()=>{require('fs').writeFileSync(${JSON.stringify(join(dir, `.foreign-${port}-signaled`))},'x');process.exit(0)});process.on('SIGINT',()=>{require('fs').writeFileSync(${JSON.stringify(join(dir, `.foreign-${port}-signaled`))},'x')})`,
    ],
    { cwd: '/', stdio: 'ignore', detached: true },
  );
  while (!(await portOpen(port))) await sleep(30);
  return {
    port,
    intact: () =>
      child.exitCode === null &&
      !existsSync(join(dir, `.foreign-${port}-signaled`)),
    stop: async () => {
      child.kill('SIGKILL');
      while (await portOpen(port)) await sleep(30);
    },
  };
}
function run({ env = {}, viaBun = false } = {}) {
  const child = spawn(
    viaBun ? BUN : process.execPath,
    viaBun ? ['run', 'dev:local'] : ['scripts/dev-local.mjs'],
    {
      cwd: dir,
      env: { ...process.env, PATH, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // its own foreground-like group, as in a terminal
    },
  );
  const state = { child, out: '', exited: false, code: undefined };
  child.stdout.on('data', (d) => (state.out += d));
  child.stderr.on('data', (d) => (state.out += d));
  child.once('exit', (code) => Object.assign(state, { exited: true, code }));
  return state;
}
/** Ctrl+C reaches the whole foreground group, not just one process. */
const ctrlC = (s) => process.kill(-s.child.pid, 'SIGINT');
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
const portsOf = (s) => {
  const m = /API na porta (\d+); PostgreSQL na porta (\d+)/.exec(s.out);
  const web = /pronto: http:\/\/[^:]+:(\d+)/.exec(s.out);
  return { api: Number(m?.[1]), db: Number(m?.[2]), web: Number(web?.[1]) };
};
const proxied = (web) =>
  fetch(`http://127.0.0.1:${web}/api/auth/config`).then(
    (r) => r.json(),
    () => ({}),
  );
async function query(sql, port = 5432) {
  const c = new pg.Client({
    connectionString: `postgres://catus:catus_local_only@127.0.0.1:${port}/catus`,
  });
  c.on('error', () => undefined);
  await c.connect();
  try {
    return (await c.query(sql)).rows;
  } finally {
    await c.end();
  }
}
const marker = (port) =>
  query(
    "SELECT count(*)::int n FROM clients WHERE name='Marca de persistência'",
    port,
  ).then((r) => r[0].n);
const sha = (file) =>
  createHash('sha256')
    .update(readFileSync(join(dir, file)))
    .digest('hex');
/** Every listener of the given ports is on loopback, in /proc/net/tcp hex. */
function onlyLoopback(ports) {
  try {
    const rows = [...readFileSync('/proc/net/tcp', 'utf8').split('\n').slice(1)]
      .map((l) => l.trim().split(/\s+/))
      .filter((c) => c[3] === '0A');
    return ports.every((p) =>
      rows
        .filter((c) => parseInt(c[1].split(':')[1], 16) === p)
        .every((c) => c[1].startsWith('0100007F')),
    );
  } catch {
    return true;
  }
}

section('Recusas, antes de iniciar qualquer coisa');
for (const [label, env, expected] of [
  [
    'banco remoto no ambiente',
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
  const s = run({ env });
  await finish(s);
  check(s.code === 1 && s.out.includes(expected), `recusa: ${label}`);
}
check(!(await portOpen(5432)), 'nenhuma recusa iniciou o PostgreSQL');

section('Porta 3000 livre: primeira execução, pelo comando recomendado');
let s = run({ viaBun: true });
check(
  (await ready(s)) && !s.exited,
  'bun run dev:local fica pronto',
  s.exited ? s.out.slice(-1800) : '',
);
let ports = portsOf(s);
check(
  ports.api === 3000 && ports.web === 5173 && ports.db === 5432,
  'usa as portas de sempre',
  JSON.stringify(ports),
);
check(
  (await fetch('http://127.0.0.1:5173/').then(
    (r) => r.status,
    () => 0,
  )) === 200,
  'Vite responde',
);
check(
  (await proxied(5173)).configured === false,
  'Vite encaminha /api; login desligado sem OIDC',
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
check(
  onlyLoopback([3000, 5173, 5432]),
  'API, Vite e PostgreSQL só no loopback',
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

section('Segunda execução no mesmo checkout');
{
  const second = run();
  await finish(second);
  check(
    second.code === 1 && second.out.includes('já está rodando neste checkout'),
    'é recusada, em vez de abrir portas alternativas',
  );
  check(
    (await portOpen(3000)) && (await portOpen(5173)) && !s.exited,
    'a primeira segue de pé',
  );
}
await query(
  `INSERT INTO clients(id,organization_id,name) VALUES('00000000-0000-4000-8000-00000000dead','00000000-0000-4000-8000-000000000001','Marca de persistência')`,
);
const hashBefore = sha('.local/database.env');
const rolesBefore = parseEnv(
  readFileSync(join(dir, '.local/database.env'), 'utf8'),
);

section('SIGINT');
ctrlC(s);
await finish(s);
check(s.code === 0, 'Ctrl+C encerra com sucesso', String(s.code));
await sleep(300);
check(
  !(await portOpen(3000)) && !(await portOpen(5173)) && !(await portOpen(5432)),
  'API, Vite e PostgreSQL encerrados',
);

section('Banco persistente: execução seguinte');
s = run();
check((await ready(s)) && !s.exited, 'fica pronta');
check(!s.out.includes('Applied '), 'nenhuma migration reaplicada');
check(!s.out.includes('criando o PostgreSQL'), 'cluster reutilizado');
check(sha('.local/database.env') === hashBefore, 'credenciais preservadas');
check((await marker(5432)) === 1, 'dados preservados em .local/postgres');
s.child.kill('SIGTERM');
await finish(s);
check(s.code === 0 && !(await portOpen(3000)), 'SIGTERM encerra tudo');
await sleep(400);

section('Porta 3000 ocupada por outro programa');
{
  const vm = await foreign(3000);
  s = run({ viaBun: true });
  check(
    (await ready(s)) && !s.exited,
    'fica pronta mesmo assim',
    s.exited ? s.out.slice(-1800) : '',
  );
  ports = portsOf(s);
  check(ports.api === 3001, 'API na porta alternativa', String(ports.api));
  check(
    s.out.includes('porta 3000 ocupada') &&
      s.out.includes('Nada foi alterado nesse processo'),
    'avisa, sem pedir para encerrar nada',
  );
  check(
    (await proxied(5173)).configured === false,
    'proxy do Vite segue para a porta escolhida',
  );
  check(
    await fetch('http://127.0.0.1:5173/api/session').then(
      (r) => r.status === 503 || r.status === 401,
      () => false,
    ),
    'API responde pelo proxy',
  );
  check(onlyLoopback([3001, 5173]), 'porta alternativa só no loopback');
  check((await marker(5432)) === 1, 'mesmo banco');
  ctrlC(s);
  await finish(s);
  await sleep(300);
  check(
    s.code === 0 && !(await portOpen(3001)) && !(await portOpen(5432)),
    'SIGINT encerra só o que é desta execução',
  );
  check(
    vm.intact() && (await portOpen(3000)),
    'o outro programa continua intacto, sem sinal nenhum',
  );
  await vm.stop();
}

section('Portas 3000, 5173 e 5432 ocupadas ao mesmo tempo');
{
  const vms = [await foreign(3000), await foreign(5173), await foreign(5432)];
  s = run();
  check(
    (await ready(s)) && !s.exited,
    'fica pronta mesmo assim',
    s.exited ? s.out.slice(-1800) : '',
  );
  ports = portsOf(s);
  check(
    ports.api === 3001 && ports.web === 5174 && ports.db === 5433,
    'três portas alternativas',
    JSON.stringify(ports),
  );
  check(
    (await proxied(5174)).configured === false,
    'proxy do Vite na porta alternativa',
  );
  check((await marker(5433)) === 1, 'mesmos dados, em outra porta');
  const moved = parseEnv(
    readFileSync(join(dir, '.local/database.env'), 'utf8'),
  );
  check(
    new URL(moved.RUNTIME_DATABASE_URL).password ===
      new URL(rolesBefore.RUNTIME_DATABASE_URL).password &&
      new URL(moved.RUNTIME_DATABASE_URL).port === '5433',
    'mesmas credenciais, na porta nova',
  );
  check(onlyLoopback([3001, 5174, 5433]), 'tudo no loopback');
  ctrlC(s);
  await finish(s);
  await sleep(300);
  check(
    s.code === 0 &&
      !(await portOpen(3001)) &&
      !(await portOpen(5174)) &&
      !(await portOpen(5433)),
    'SIGINT encerra só o que é desta execução',
  );
  check(
    vms.every((v) => v.intact()),
    'os três programas continuam intactos',
  );
  for (const v of vms) await v.stop();
}
s = run();
await ready(s);
check(
  portsOf(s).db === 5432 && (await marker(5432)) === 1 && !s.exited,
  'com a porta livre de novo, volta para 5432 com os mesmos dados',
);
ctrlC(s);
await finish(s);
await sleep(300);

section('Porta tomada por outro programa depois de conferida');
{
  // Vite loads its config right before listening: the only moment this race can be staged.
  const config = join(dir, 'vite.config.ts');
  const original = readFileSync(config, 'utf8');
  const taker = join(dir, '.taker-pid');
  writeFileSync(
    config,
    `import { spawn as spawnTaker } from 'node:child_process';
import { connect as probe } from 'node:net';
import { existsSync as seen, writeFileSync as note } from 'node:fs';
if (!seen(${JSON.stringify(taker)})) {
  const c = spawnTaker(process.execPath, ['-e', "require('net').createServer().listen(5173,'127.0.0.1')"], { detached: true, stdio: 'ignore', cwd: '/' });
  c.unref();
  note(${JSON.stringify(taker)}, String(c.pid));
  for (let up = false; !up; ) up = await new Promise((r) => { const s = probe(5173, '127.0.0.1'); s.once('connect', () => (s.destroy(), r(true))); s.once('error', () => setTimeout(() => r(false), 30)); });
}
` + original,
  );
  s = run();
  check(
    (await ready(s)) && !s.exited,
    'tenta outra porta sozinho',
    s.exited ? s.out.slice(-1800) : '',
  );
  ports = portsOf(s);
  check(ports.web === 5174, 'Vite na porta seguinte', String(ports.web));
  check(
    (await proxied(5174)).configured === false,
    'proxy funciona depois da nova tentativa',
  );
  check(
    (s.out.match(/Catus listening/g)?.length ?? 0) === 2,
    'API reiniciada com a origem certa',
  );
  ctrlC(s);
  await finish(s);
  await sleep(300);
  const takerPid = Number(readFileSync(taker, 'utf8'));
  let takerAlive = true;
  try {
    process.kill(takerPid, 0);
  } catch {
    takerAlive = false;
  }
  check(takerAlive, 'quem tomou a porta continua intacto');
  process.kill(takerPid, 'SIGKILL');
  writeFileSync(config, original);
  while (await portOpen(5173)) await sleep(30);
}

section('Execução morta de forma abrupta');
s = run();
await ready(s);
s.child.kill('SIGKILL');
await sleep(500);
check(await portOpen(3000), 'SIGKILL deixa a API órfã (cenário preparado)');
s = run();
check(
  (await ready(s)) && !s.exited,
  'a execução seguinte recupera sozinha',
  s.exited ? s.out.slice(-1800) : '',
);
check(
  s.out.includes('deixado por uma execução interrompida') &&
    s.out.includes('reutilizando o PostgreSQL'),
  'encerra as próprias sobras e reaproveita o banco',
);
check(
  portsOf(s).api === 3000,
  'não precisa de porta alternativa por causa das próprias sobras',
);
check((await marker(5432)) === 1, 'dados preservados');
ctrlC(s);
await finish(s);
await sleep(500);
check(!(await portOpen(5432)), 'banco adotado encerra junto');

section('Um processo que falha');
s = run();
await ready(s);
const pids = JSON.parse(
  readFileSync(join(dir, '.local/dev-local.pids'), 'utf8'),
);
process.kill(-pids.web, 'SIGKILL');
await finish(s);
check(
  s.code === 1 && s.out.includes('web terminou sozinho'),
  'encerra o restante, com aviso',
);
await sleep(500);
check(
  !(await portOpen(3000)) && !(await portOpen(5432)),
  'nada fica para trás',
);

section('--prepare-only');
{
  const p = spawnSync(
    process.execPath,
    ['scripts/dev-local.mjs', '--prepare-only'],
    { cwd: dir, encoding: 'utf8', env: { ...process.env, PATH } },
  );
  check(
    p.status === 0 && p.stdout.includes('banco pronto'),
    'prepara o banco e sai',
    p.stderr?.slice(0, 200),
  );
  check(!(await portOpen(5432)), 'não deixa o banco de pé');
}

section('Com OIDC no .env');
// Nothing reaches Google here: discovery only happens when someone clicks to log in.
appendFileSync(
  join(dir, '.env'),
  'OIDC_ISSUER=https://accounts.google.com\nOIDC_CLIENT_ID=dev-teste\nOIDC_CLIENT_SECRET=dev-teste\n',
);
{
  const vm = await foreign(5173);
  s = run();
  check((await ready(s)) && !s.exited, 'fica pronto');
  check((await proxied(5174)).configured === true, 'login ligado pelo .env');
  check(
    s.out.includes('cadastre também http://127.0.0.1:5174/api/auth/callback'),
    'avisa que o Google precisa do endereço da porta alternativa',
  );
  const bootstrap = spawnSync(
    BUN,
    [
      'run',
      'bootstrap:admin',
      '--email',
      'admin@exemplo.test',
      '--name',
      'Admin Dev',
    ],
    { cwd: dir, encoding: 'utf8', env: { ...process.env, PATH } },
  );
  check(
    bootstrap.status === 0,
    'bun run bootstrap:admin funciona',
    (bootstrap.stderr || bootstrap.stdout).trim().slice(0, 200),
  );
  ctrlC(s);
  await finish(s);
  check(s.code === 0 && vm.intact(), 'encerra com OIDC ligado');
  await vm.stop();
}

section('Sem Docker');
check(!existsSync(dockerMark), 'nenhuma execução chamou o Docker');

console.log(
  failures
    ? `\n${failures} falha(s). Cópia preservada em ${dir}`
    : `\nTudo certo. Cópia descartável em ${dir}`,
);
process.exit(failures ? 1 : 0);
