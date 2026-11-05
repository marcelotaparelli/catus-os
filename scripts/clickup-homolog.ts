// Assisted ClickUp homologation, in a clone made only for it (docs/CLICKUP_HOMOLOGACAO.md).
//   bun run clickup:homolog init     marks a fresh clone; refuses any directory with .local
//   bun run clickup:homolog          checks and prepares, then STOPS before ClickUp
//   bun run clickup:homolog report   read-only figures to compare with ClickUp after a read
// It never calls ClickUp, never prints a secret, and only touches the PostgreSQL whose data
// directory is this clone's .local/postgres.
import pg from 'pg';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { parseArgs, parseEnv } from 'node:util';
import { provisionClickupRole } from './lib/clickup-role';
import {
  DEFAULT_ORGANIZATION,
  MARKER,
  WORKER_PRIVILEGES,
  formatReport,
  upsertEnv,
} from './lib/clickup-homolog.mjs';
import {
  SecretFileError,
  defaultTokenFile,
  readSecretFile,
} from './lib/secret-file.mjs';

type Status = 'ok' | 'pending' | 'fail';
const items: { status: Status; title: string; detail?: string }[] = [];
const add = (status: Status, title: string, detail?: string) =>
  items.push({ status, title, detail });
const { values: opts, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    workspace: { type: 'string' },
    'admin-email': { type: 'string' },
    'admin-name': { type: 'string' },
  },
});
const command = positionals[0] ?? 'check';
const git = (...args: string[]) => spawnSync('git', args, { encoding: 'utf8' });
const finish = (code?: number) => {
  console.log(formatReport(items));
  process.exit(code ?? (items.some((i) => i.status === 'fail') ? 1 : 0));
};

if (command === 'init') {
  const top = git('rev-parse', '--show-toplevel').stdout.trim();
  if (!top || realpathSync(top) !== realpathSync(process.cwd())) {
    console.error('Rode na raiz de um clone do repositório.');
    process.exit(1);
  }
  if (existsSync('.local') || existsSync('.env')) {
    console.error(
      'Recusado: este diretório já tem .local ou .env, então pode ser uma instalação em uso. Faça um clone novo só para a homologação. Nada foi alterado.',
    );
    process.exit(1);
  }
  mkdirSync('.local', { mode: 0o700 });
  writeFileSync(
    MARKER,
    JSON.stringify({
      purpose: 'clickup-homologation',
      created_at: new Date().toISOString(),
      commit: git('rev-parse', 'HEAD').stdout.trim(),
    }) + '\n',
    { mode: 0o600, flag: 'wx' },
  );
  console.log(
    'Clone marcado para a homologação.\n  1. Em outro terminal: bun run dev:local\n  2. Aqui: bun run clickup:homolog',
  );
  process.exit(0);
}
if (!['check', 'report'].includes(command)) {
  console.error('Uso: clickup:homolog [init|check|report]');
  process.exit(2);
}

// ---- 1. Isolation -------------------------------------------------------------------
if (!existsSync(MARKER)) {
  add(
    'fail',
    'Clone de homologação',
    'Sem a marca deste fluxo. Use um clone novo e rode "bun run clickup:homolog init" antes do dev:local.',
  );
  finish();
}
if (!existsSync('.local/database.env')) {
  add('pending', 'Banco', 'Inicie "bun run dev:local" em outro terminal.');
  finish();
}
const rolesText = readFileSync('.local/database.env', 'utf8');
const roles = parseEnv(rolesText) as Record<string, string>;
const migration = new URL(roles.MIGRATION_DATABASE_URL ?? '');
const admin = new URL(migration);
// The embedded cluster's own superuser (scripts/postgres.mjs), valid only on loopback here.
admin.username = 'catus';
admin.password = 'catus_local_only';
admin.pathname = '/catus';
if (!['127.0.0.1', 'localhost'].includes(admin.hostname)) {
  add('fail', 'Banco', 'O banco não está em loopback.');
  finish();
}
const db = new pg.Client({
  connectionString: admin.href,
  connectionTimeoutMillis: 3000,
});
try {
  await db.connect();
} catch {
  add(
    'pending',
    'Banco',
    'dev:local não está rodando; inicie em outro terminal.',
  );
  finish();
}
const one = async <T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
) => (await db.query(sql, params)).rows[0] as T;
const dataDir = (await one<{ data_directory: string }>('SHOW data_directory'))
  .data_directory;
if (realpathSync(dataDir) !== realpathSync('.local/postgres')) {
  add(
    'fail',
    'Banco isolado',
    'O PostgreSQL conectado não é o deste clone. Nada foi alterado.',
  );
  await db.end();
  finish();
}
add(
  'ok',
  'Banco isolado',
  `cluster próprio em ${dataDir}, porta ${admin.port}`,
);

if (command === 'report') {
  await report();
  await db.end();
  process.exit(0);
}

// ---- 2. Migrations -------------------------------------------------------------------
const files = readdirSync('db/migrations').filter((f) => f.endsWith('.sql'));
const applied = new Set(
  (await db.query('SELECT name FROM schema_migrations')).rows.map(
    (r) => r.name,
  ),
);
const missing = files.filter((f) => !applied.has(f));
if (missing.length) add('fail', 'Migrations', `faltam: ${missing.join(', ')}`);
else
  add(
    'ok',
    'Migrations',
    `${files.length} aplicadas, última ${files.sort().at(-1)}`,
  );

// ---- 3. Worker account ---------------------------------------------------------------
let workerUrl = roles.CLICKUP_WORKER_DATABASE_URL;
if (!workerUrl) {
  workerUrl = (await provisionClickupRole(admin.href, '.local/database.env'))
    .CLICKUP_WORKER_DATABASE_URL;
  add(
    'ok',
    'Conta do worker criada',
    'credencial só em .local/database.env (0600)',
  );
}
const migrate = spawnSync(
  'node_modules/.bin/bun',
  ['--no-env-file', 'scripts/migrate.ts'],
  {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ...(parseEnv(readFileSync('.local/database.env', 'utf8')) as Record<
        string,
        string
      >),
    },
  },
);
add(
  migrate.status === 0 ? 'ok' : 'fail',
  'Privilégios reaplicados (migrate)',
  migrate.status === 0
    ? undefined
    : 'migrate falhou; rode "bun run migrate" e veja o erro',
);
const worker = new pg.Client({ connectionString: workerUrl });
await worker.connect();
const wrong: string[] = [];
for (const [table, privilege, expected] of WORKER_PRIVILEGES) {
  const r = await worker.query(
    'SELECT to_regclass($1) IS NOT NULL present, CASE WHEN to_regclass($1) IS NULL THEN NULL ELSE has_table_privilege($1,$2) END allowed',
    ['public.' + table, privilege],
  );
  if (r.rows[0].present && r.rows[0].allowed !== expected)
    wrong.push(
      `${privilege} em ${table}: ${r.rows[0].allowed ? 'tem' : 'não tem'}`,
    );
}
const attrs = (
  await worker.query(
    'SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls elevated FROM pg_roles WHERE rolname=current_user',
  )
).rows[0];
if (attrs.elevated) wrong.push('atributos elevados');
await worker.end();
add(
  wrong.length ? 'fail' : 'ok',
  'Privilégios mínimos do worker',
  wrong.length
    ? wrong.join('; ')
    : `${WORKER_PRIVILEGES.length} verificações: sem economia, contratos, demandas, pessoas ou mapeamentos; sem DELETE`,
);

// The real worker, through its real launcher, refuses stronger accounts. Only with no active
// link (nothing it could read) and a closed proxy, so no request can leave even by mistake.
const links = Number(
  (
    await one<{ n: string }>(
      'SELECT count(*) n FROM clickup_project_links WHERE active',
    )
  ).n,
);
const dummy = 'homolog-check-not-a-real-token';
const runWorker = (url: string) => {
  const r = spawnSync(
    'node',
    ['scripts/runtime.mjs', '--clickup-worker', '--once'],
    {
      encoding: 'utf8',
      timeout: 30000,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        CLICKUP_ENABLED: 'true',
        CLICKUP_ORGANIZATION_ID: DEFAULT_ORGANIZATION,
        CLICKUP_WORKSPACE_ID: '1',
        CLICKUP_API_TOKEN: dummy,
        CLICKUP_WORKER_DATABASE_URL: url,
        HTTPS_PROXY: 'http://127.0.0.1:9',
        HTTP_PROXY: 'http://127.0.0.1:9',
      },
    },
  );
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
};
const marker = JSON.parse(readFileSync(MARKER, 'utf8'));
if (links)
  add(
    marker.worker_refusal_verified_at ? 'ok' : 'pending',
    'Worker real recusa contas fortes',
    marker.worker_refusal_verified_at
      ? `verificado em ${marker.worker_refusal_verified_at}, antes do vínculo; não repetido agora para não ler a lista`
      : 'não verificada: já existe lista vinculada e o teste não deve ler nada. Desvincule, rode de novo e vincule depois.',
  );
else {
  const results: string[] = [];
  let ok = true;
  for (const [name, url] of [
    ['runtime da web', roles.RUNTIME_DATABASE_URL!],
    ['migrações', roles.MIGRATION_DATABASE_URL!],
    ['administrador do cluster', admin.href],
  ] as const) {
    const r = runWorker(url);
    const refused = r.code !== 0 && r.out.includes('overprivileged');
    ok &&= refused && !r.out.includes(dummy);
    results.push(
      `${name}: ${refused ? 'recusada' : `ACEITA (código ${r.code})`}`,
    );
  }
  const own = runWorker(workerUrl);
  const fine = own.code === 0 && own.out.includes('0 list(s) processed');
  ok &&= fine && !own.out.includes(dummy);
  results.push(
    `própria: ${fine ? 'aceita, 0 listas, nenhuma chamada' : `falhou (código ${own.code})`}`,
  );
  add(
    ok ? 'ok' : 'fail',
    'Worker real recusa contas fortes',
    results.join('; '),
  );
  if (ok)
    writeFileSync(
      MARKER,
      JSON.stringify({
        ...marker,
        worker_refusal_verified_at: new Date().toISOString(),
      }) + '\n',
    );
}

// ---- 4. Configuration (.env) ---------------------------------------------------------
const envStat = existsSync('.env') ? lstatSync('.env') : null;
if (!envStat) add('pending', '.env', 'ainda não criado pelo dev:local');
else {
  const tracked = git('ls-files', '--error-unmatch', '.env').status === 0;
  const ignored = git('check-ignore', '-q', '.env').status === 0;
  add(
    envStat.mode & 0o077 || tracked || !ignored ? 'fail' : 'ok',
    '.env protegido',
    envStat.mode & 0o077
      ? 'permissões abertas: chmod 600 .env'
      : tracked || !ignored
        ? '.env está no Git ou não é ignorado'
        : '0600, ignorado pelo Git',
  );
}
const envText = envStat ? readFileSync('.env', 'utf8') : '';
const env = parseEnv(envText) as Record<string, string>;
if (env.CLICKUP_API_TOKEN)
  add(
    'fail',
    'Token fora do .env',
    'há CLICKUP_API_TOKEN em texto no .env: apague a linha e use "bun run clickup:token"',
  );
const workspace = opts.workspace ?? env.CLICKUP_WORKSPACE_ID;
if (opts.workspace && !/^\d{1,20}$/.test(opts.workspace)) {
  add(
    'fail',
    'Workspace ID',
    'só dígitos, como na URL app.clickup.com/<workspace>/',
  );
} else if (envStat) {
  const wanted: Record<string, string> = {
    CLICKUP_ORGANIZATION_ID: DEFAULT_ORGANIZATION,
    CLICKUP_REQUESTS_PER_MINUTE: env.CLICKUP_REQUESTS_PER_MINUTE || '30',
    CLICKUP_API_TOKEN_FILE: env.CLICKUP_API_TOKEN_FILE || defaultTokenFile(),
    ...(workspace
      ? { CLICKUP_WORKSPACE_ID: workspace, CLICKUP_ENABLED: 'true' }
      : {}),
  };
  const next = upsertEnv(envText, wanted);
  if (next !== envText) {
    writeFileSync('.env', next);
    add(
      'ok',
      'Configuração do ClickUp gravada no .env',
      `${Object.keys(wanted).join(', ')} (nenhum segredo). Reinicie o dev:local para a API ver.`,
    );
  }
  Object.assign(env, parseEnv(next));
}
if (!workspace)
  add(
    'pending',
    'Workspace ID do ClickUp',
    'rode de novo com --workspace <id> (dígitos da URL app.clickup.com/<id>/)',
  );

// ---- 5. Panel authentication ---------------------------------------------------------
const api = runningApi();
const callback = `${api.origin}/api/auth/callback`;
const oidcKeys = ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET'];
const absent = oidcKeys.filter((k) => !env[k]);
if (absent.length)
  add(
    'pending',
    'Login OIDC',
    `faltam ${absent.join(', ')} no .env (cliente de desenvolvimento, docs/DEV_LOCAL.md). URI de redirecionamento a cadastrar: ${callback}`,
  );
else if (!env.OIDC_ISSUER!.startsWith('https://'))
  add('fail', 'Login OIDC', 'OIDC_ISSUER precisa ser HTTPS');
else {
  let discovery = false;
  try {
    const r = await fetch(
      env.OIDC_ISSUER!.replace(/\/$/, '') + '/.well-known/openid-configuration',
      { signal: AbortSignal.timeout(5000) },
    );
    discovery = r.ok;
  } catch {}
  add(
    discovery ? 'ok' : 'pending',
    'Emissor OIDC alcançável',
    discovery
      ? env.OIDC_ISSUER
      : 'sem resposta do emissor a partir desta máquina',
  );
  add(
    'ok',
    'Cliente OIDC no .env',
    `segredo não exibido; URI de redirecionamento: ${callback}`,
  );
}
let configured = false;
if (api.port)
  try {
    configured = (
      await (
        await fetch(`http://127.0.0.1:${api.port}/api/auth/config`, {
          signal: AbortSignal.timeout(3000),
        })
      ).json()
    ).configured;
  } catch {}
add(
  configured ? 'ok' : 'pending',
  'API com login ativo',
  configured
    ? `API na porta ${api.port}, painel em ${api.origin}`
    : 'reinicie o dev:local depois de preencher OIDC_* no .env',
);
add(
  api.clickup ? 'ok' : 'pending',
  'API com a integração ligada',
  api.clickup
    ? 'painel de execução visível para gestor e administrador'
    : 'reinicie o dev:local depois do --workspace',
);
const adminUser = await one<{ email: string }>(
  "SELECT u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1 AND m.role='administrator' AND m.active LIMIT 1",
  [DEFAULT_ORGANIZATION],
);
if (adminUser) add('ok', 'Administrador autorizado', adminUser.email);
else if (opts['admin-email'] && !absent.length) {
  const r = spawnSync(
    'node_modules/.bin/bun',
    [
      '--env-file=.env',
      '--env-file=.local/database.env',
      'scripts/bootstrap-admin.ts',
      '--email',
      opts['admin-email'],
      '--name',
      opts['admin-name'] ?? opts['admin-email'],
    ],
    { encoding: 'utf8' },
  );
  add(
    r.status === 0 ? 'ok' : 'fail',
    'Administrador autorizado',
    r.status === 0 ? opts['admin-email'] : 'bootstrap:admin falhou',
  );
} else
  add(
    'pending',
    'Administrador autorizado',
    'rode de novo com --admin-email <seu e-mail> --admin-name "<seu nome>" (depois do OIDC)',
  );

// ---- 6. Token and link ---------------------------------------------------------------
const tokenFile = env.CLICKUP_API_TOKEN_FILE || defaultTokenFile();
if (!existsSync(tokenFile))
  add(
    'pending',
    'Token da conta de serviço',
    'na máquina autorizada, num terminal: bun run clickup:token (sem eco, 0600, fora do repositório)',
  );
else
  try {
    readSecretFile(tokenFile, { repository: process.cwd() });
    add(
      'ok',
      'Token da conta de serviço',
      `${tokenFile}: 0600, fora do repositório, lido como dado; conteúdo não exibido`,
    );
  } catch (e) {
    add(
      'fail',
      'Token da conta de serviço',
      e instanceof SecretFileError ? e.message : 'ilegível',
    );
  }
const linked = (
  await db.query(
    'SELECT l.list_id,p.name FROM clickup_project_links l JOIN projects p ON p.id=l.project_id WHERE l.active ORDER BY l.created_at',
  )
).rows;
add(
  linked.length === 1 ? 'ok' : 'pending',
  'Lista do piloto vinculada',
  linked.length === 1
    ? `lista ${linked[0].list_id} → projeto "${linked[0].name}"`
    : linked.length
      ? `${linked.length} listas vinculadas; o piloto usa uma só`
      : 'no painel: projeto > Execução no ClickUp > Listas vinculadas',
);
await db.end();

const blocked = items.some((i) => i.status !== 'ok');
console.log(formatReport(items));
console.log(
  `\nPARADO antes de qualquer conexão ao ClickUp. Nenhuma chamada foi feita.\n${
    blocked
      ? 'Resolva os itens PENDENTE/FALHA e rode "bun run clickup:homolog" de novo.'
      : 'Tudo pronto. Com a sua autorização, a primeira leitura é:\n  bun run clickup:worker -- --once\ne a conferência: bun run clickup:homolog report'
  }`,
);
process.exit(items.some((i) => i.status === 'fail') ? 1 : 0);

/** Port and origin of the API this clone's dev:local started; nothing else is read. */
function runningApi() {
  const fallback = {
    port: 0,
    origin: env.APP_ORIGIN ?? 'http://127.0.0.1:5173',
    clickup: false,
  };
  try {
    const pids = JSON.parse(readFileSync('.local/dev-local.pids', 'utf8'));
    const environ = readFileSync(
      `/proc/${Number(pids.api)}/environ`,
      'utf8',
    ).split('\0');
    const value = (key: string) =>
      environ.find((l) => l.startsWith(key + '='))?.slice(key.length + 1);
    return {
      port: Number(value('PORT')) || 0,
      origin: value('APP_ORIGIN') ?? fallback.origin,
      clickup: value('CLICKUP_ENABLED') === 'true',
    };
  } catch {
    return fallback;
  }
}

/** Figures to compare with the ClickUp list view (closed and subtasks shown, no filter). */
async function report() {
  const links = (
    await db.query(
      `SELECT l.id,l.list_id,l.list_name,p.name project,l.last_success_at,l.last_error_code,l.last_data_warnings
 FROM clickup_project_links l JOIN projects p ON p.id=l.project_id WHERE l.active ORDER BY l.created_at`,
    )
  ).rows;
  if (!links.length) console.log('Nenhuma lista vinculada.');
  for (const l of links) {
    console.log(
      `\n== Lista ${l.list_id} "${l.list_name ?? '?'}" → projeto "${l.project}"\nÚltima leitura OK: ${l.last_success_at?.toISOString() ?? 'nunca'}; erro: ${l.last_error_code ?? 'nenhum'}; avisos de dados: ${l.last_data_warnings}`,
    );
    const live = `FROM clickup_list_tasks m JOIN clickup_tasks t USING (organization_id,task_id) WHERE m.link_id=$1 AND m.missing_since IS NULL`;
    console.table(
      (
        await db.query(
          `SELECT t.status_raw status,t.status_type tipo,count(*) FILTER (WHERE t.parent_task_id IS NULL)::int tarefas,count(*) FILTER (WHERE t.parent_task_id IS NOT NULL)::int subtarefas ${live} GROUP BY 1,2 ORDER BY 1`,
          [l.id],
        )
      ).rows,
    );
    console.table(
      (
        await db.query(
          `SELECT coalesce(p.display_name,'(sem nome) '||x.a) responsavel,count(*)::int abertas
 FROM (SELECT t.organization_id,unnest(t.assignee_ids) a ${live} AND t.status_type NOT IN ('closed','done')) x
 LEFT JOIN clickup_people p ON p.organization_id=x.organization_id AND p.clickup_user_id=x.a
 GROUP BY 1 ORDER BY 2 DESC,1`,
          [l.id],
        )
      ).rows,
    );
    console.table(
      (
        await db.query(
          `SELECT count(*) FILTER (WHERE t.status_type NOT IN ('closed','done') AND cardinality(t.assignee_ids)=0)::int sem_responsavel,
 count(*) FILTER (WHERE t.status_type NOT IN ('closed','done') AND t.due_at IS NOT NULL AND (CASE WHEN t.due_has_time THEN t.due_at ELSE t.due_at+interval '1 day' END)<now())::int atrasadas,
 count(*) FILTER (WHERE t.home_list_id IS NULL)::int sem_lista_principal ${live}`,
          [l.id],
        )
      ).rows,
    );
  }
}
