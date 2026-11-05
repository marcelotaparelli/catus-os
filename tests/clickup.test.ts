// M6.1. Synthetic only: a fake ClickUp over real HTTP, real PostgreSQL with the real database
// accounts, the real API. No real token or workspace. Passing here proves the code against
// the documented shape of the API, not against an actual ClickUp workspace.
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { createApp } from '../src/server/app';
import { oidcProvider } from '../src/server/auth/oidc';
import {
  ClickUpError,
  createClickUpClient,
} from '../src/server/clickup/client';
import {
  clickupOrganization,
  clickupWorkerConfig,
} from '../src/server/clickup/config';
import {
  parseDate,
  parseTask,
  parseTaskPage,
} from '../src/server/clickup/parse';
import {
  claimDueLink,
  MAX_PAGES,
  runDueSyncs,
  syncClaimed,
} from '../src/server/clickup/sync';
import {
  freshnessOf,
  isOverdue,
  STALE_AFTER_MINUTES,
  summarize,
} from '../src/server/clickup/summary';
import type { ProjectExecution } from '../src/shared/clickup';
import type { FinancialOverview } from '../src/shared/overview';
import { loadConfig } from '../src/server/config';
import { provisionRoles } from '../scripts/lib/provision-roles';
import { provisionClickupRole } from '../scripts/lib/clickup-role';
import { ident } from '../scripts/lib/privileges';
import { dropDisposableDatabase } from './support/disposable';
import { codeFor, config, mockOidcFetch } from './support/oidc-provider';

const TOKEN = 'pk_synthetic_' + randomBytes(12).toString('hex');
const WORKSPACE = '7002367';
const name = `cu_${randomBytes(4).toString('hex')}_test`;
const roleFile = `.local/clickup-${name}.env`;
const control = new URL(process.env.DATABASE_URL!);
control.pathname = '/postgres';
const target = new URL(control);
target.pathname = '/' + name;
const admin = new pg.Pool({ connectionString: control.href });
let db: pg.Pool, runtime: pg.Pool, workerDb: pg.Pool;
let workerUrl = '',
  runtimeUrl = '',
  roleEnv: Record<string, string> = {};
const org = crypto.randomUUID(),
  foreignOrg = crypto.randomUUID();
const users: Record<string, string> = {
  admin: crypto.randomUUID(),
  manager: crypto.randomUUID(),
  po: crypto.randomUUID(),
  dev: crypto.randomUUID(),
  foreign: crypto.randomUUID(),
};
const sessions: Record<string, { cookie: string; csrf: string }> = {};
let app: ReturnType<typeof createApp>, appOff: ReturnType<typeof createApp>;
const syncOptions = {
  organizationId: org,
  workspaceId: WORKSPACE,
  syncMinutes: 15,
};

// ---- Fake ClickUp, reached by the real client over real HTTP ----
type Reply = (url: URL) => Response | Promise<Response>;
const seen: { method: string; url: URL; auth: string | null; body: string }[] =
  [];
const lists = new Map<string, unknown[]>();
let pageSize = 2;
let fault: Reply | null = null;
const task = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: 'Tarefa ' + id,
  team_id: WORKSPACE,
  url: 'https://app.clickup.com/t/' + id,
  status: { status: 'to do', type: 'open', color: '#000', orderindex: 0 },
  date_created: '1767225600000',
  date_updated: '1767225600000',
  date_closed: null,
  date_done: null,
  assignees: [],
  dependencies: [],
  parent: null,
  due_date: null,
  due_date_time: false,
  start_date: null,
  ...extra,
});
const fake = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    seen.push({
      method: req.method,
      url,
      auth: req.headers.get('authorization'),
      body: await req.text(),
    });
    // Any other verb is a defect this suite must see, not a call to tolerate.
    if (req.method !== 'GET') return new Response('{}', { status: 405 });
    if (fault) {
      const r = await fault(url);
      if (r.status !== 299) return r;
    }
    const m = /^\/list\/(\d+)(\/task)?$/.exec(url.pathname);
    const items = m && lists.get(m[1]!);
    if (!items) return new Response('{"err":"no"}', { status: 404 });
    if (!m![2]) return Response.json({ id: m![1], name: 'Lista ' + m![1] });
    const page = Number(url.searchParams.get('page'));
    const slice = items.slice(page * pageSize, (page + 1) * pageSize);
    return Response.json({
      tasks: slice,
      last_page: (page + 1) * pageSize >= items.length,
    });
  },
});
const client = () =>
  createClickUpClient({
    token: TOKEN,
    requestsPerMinute: 600000,
    baseUrl: `http://127.0.0.1:${fake.port}`,
    timeoutMs: 2000,
  });
const sync = (c = client()) => runDueSyncs(workerDb, c, syncOptions);
// Only the lists of the running test: the rate-limit stop applies across lists.
let mine: string[] = [];
const makeDue = () =>
  db.query(
    'UPDATE clickup_project_links SET next_sync_at=now() WHERE id=ANY($1::uuid[])',
    [mine],
  );
/** The next `n` task-page requests answer normally, then the fault. Lists always pass. */
function failAfterPages(n: number, reply: () => Response) {
  let left = n;
  fault = (url) => {
    if (!url.pathname.endsWith('/task'))
      return new Response('', { status: 299 });
    if (left-- > 0) return new Response('', { status: 299 });
    return reply();
  };
}

// ---- Catus API ----
async function raw(
  who: string,
  path: string,
  method = 'GET',
  body?: unknown,
  handler = app,
) {
  const a = sessions[who];
  return handler(
    new Request(config.origin + '/api/' + path, {
      method,
      headers: {
        ...(a ? { Cookie: a.cookie, 'X-CSRF-Token': a.csrf } : {}),
        Origin: config.origin,
        'Content-Type': 'application/json',
        'Idempotency-Key': crypto.randomUUID(),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    'clickup-tests',
  );
}
async function call<T = any>(
  who: string,
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  const res = await raw(who, path, method, body);
  if (!res.ok)
    throw new Error(
      `${who} ${method} ${path}: ${res.status} ${await res.text()}`,
    );
  return res.json() as Promise<T>;
}
async function login(email: string) {
  const start = await raw('', 'auth/login');
  const auth = new URL(start.headers.get('location')!);
  const back = await app(
    new Request(
      `${config.origin}/api/auth/callback?state=${auth.searchParams.get('state')}&code=${codeFor(auth, email)}`,
      { headers: { Cookie: start.headers.getSetCookie()[0]!.split(';')[0]! } },
    ),
    'clickup-tests',
  );
  const cookie = back.headers
    .getSetCookie()
    .find((s) => s.startsWith('catus_session='))!
    .split(';')[0]!;
  const session = await (
    await app(
      new Request(config.origin + '/api/session', {
        headers: { Cookie: cookie },
      }),
      'clickup-tests',
    )
  ).json();
  return { cookie, csrf: session.csrfToken as string };
}
async function newProject(label: string, who = 'manager') {
  const c = await call(who, 'clients', 'POST', { name: 'Cliente ' + label });
  return (
    await call(who, 'projects', 'POST', {
      client_id: c.id,
      name: 'Projeto ' + label,
    })
  ).id as string;
}
const link = (projectId: string, listId: string) =>
  call('manager', 'clickup/links', 'POST', {
    project_id: projectId,
    list_id: listId,
  });
const execution = async (projectId: string, who = 'manager') =>
  (await call<FinancialOverview>(who, 'overview')).projects.find(
    (p) => p.project_id === projectId,
  )!.execution as ProjectExecution;
let nextList = 1000;
async function linked(items: unknown[]) {
  const projectId = await newProject(crypto.randomUUID().slice(0, 8));
  const listId = String(nextList++);
  lists.set(listId, items);
  const l = await link(projectId, listId);
  mine.push(l.id);
  return { projectId, listId, linkId: l.id as string };
}
const lastRun = async (linkId: string) =>
  (
    await db.query(
      'SELECT * FROM clickup_sync_runs WHERE link_id=$1 ORDER BY started_at DESC,id LIMIT 1',
      [linkId],
    )
  ).rows[0];

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${ident(name)}`);
  const roles = await provisionRoles(target.href, roleFile);
  const p = Bun.spawn(['node_modules/.bin/bun', 'scripts/migrate.ts'], {
    env: { ...process.env, ...roles },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  if ((await p.exited) !== 0) throw new Error('Migration failed');
  const worker = await provisionClickupRole(target.href, roleFile);
  workerUrl = worker.CLICKUP_WORKER_DATABASE_URL;
  runtimeUrl = roles.RUNTIME_DATABASE_URL;
  roleEnv = { ...roles } as unknown as Record<string, string>;
  db = new pg.Pool({ connectionString: target.href });
  runtime = new pg.Pool({ connectionString: roles.RUNTIME_DATABASE_URL });
  workerDb = new pg.Pool({
    connectionString: worker.CLICKUP_WORKER_DATABASE_URL,
    statement_timeout: 5000,
  });
  await db.query('INSERT INTO organizations(id,name) VALUES($1,$2),($3,$4)', [
    org,
    'Agência sintética',
    foreignOrg,
    'Outra agência',
  ]);
  for (const [key, role, o] of [
    ['admin', 'administrator', org],
    ['manager', 'manager', org],
    ['po', 'po', org],
    ['dev', 'developer', org],
    ['foreign', 'manager', foreignOrg],
  ] as const) {
    await db.query(
      'INSERT INTO users(id,issuer,email,display_name) VALUES($1,$2,$3,$4)',
      [users[key], config.oidc!.issuer, `${key}@catus.test`, key],
    );
    await db.query(
      'INSERT INTO memberships(user_id,organization_id,role) VALUES($1,$2,$3)',
      [users[key], o, role],
    );
  }
  const options = {
    pool: runtime,
    extractionProvider: null,
    loginRate: { limit: 1000, windowSeconds: 60 },
    apiRate: { limit: 5000, windowSeconds: 60 },
  };
  const provider = oidcProvider(config, await mockOidcFetch());
  app = createApp({ ...config, clickupOrganizationId: org }, provider, options);
  appOff = createApp(config, provider, options);
  for (const k of Object.keys(users))
    sessions[k] = await login(`${k}@catus.test`);
}, 120000);
afterAll(async () => {
  fake.stop(true);
  await Promise.all([db?.end(), runtime?.end(), workerDb?.end()]);
  await dropDisposableDatabase(admin, name);
  for (const r of ['runtime', 'migrator', 'maintenance', 'aiworker', 'clickup'])
    await admin.query(`DROP ROLE IF EXISTS ${ident(name + '_' + r)}`);
  await admin.end();
  rmSync(roleFile, { force: true });
});
beforeEach(async () => {
  fault = null;
  pageSize = 2;
  seen.length = 0;
  mine = [];
  // Each test owns its lists: anything left from another test is not due.
  await db.query(
    "UPDATE clickup_project_links SET next_sync_at=now()+interval '1 day'",
  );
});

// ---- No external write ----
test('every request to ClickUp is a bodyless GET with the token, whatever the outcome', async () => {
  const { linkId } = await linked([task('w1'), task('w2'), task('w3')]);
  await sync();
  await makeDue();
  failAfterPages(1, () => new Response('', { status: 500 }));
  await sync();
  expect((await lastRun(linkId)).state).toBe('failed');
  expect(seen.length).toBeGreaterThan(3);
  for (const r of seen) {
    expect(r.method).toBe('GET');
    expect(r.body).toBe('');
    expect(r.auth).toBe(TOKEN);
  }
});
test('the code has one network exit, which cannot express another verb', () => {
  const dir = 'src/server/clickup';
  const files = readdirSync(dir).map((f) => `${dir}/${f}`);
  files.push('scripts/clickup-worker.ts');
  const sources = files.map((f) => [f, readFileSync(f, 'utf8')] as const);
  for (const [f, text] of sources) {
    expect([
      f,
      f !== `${dir}/service.ts` &&
        /\b(POST|PUT|PATCH|DELETE)\b['"`]/.test(text),
    ]).toEqual([f, false]);
    if (f !== `${dir}/client.ts`)
      expect([
        f,
        /\bfetch\s*\(|send\s*\(|api\.clickup\.com/.test(text),
      ]).toEqual([f, false]);
  }
  const clientText = readFileSync(`${dir}/client.ts`, 'utf8');
  expect(clientText.match(/method: /g)).toHaveLength(1);
  expect(clientText).toContain("method: 'GET'");
  // The public surface has reads only.
  expect(Object.keys(client()).sort()).toEqual([
    'calls',
    'getList',
    'getTasksPage',
  ]);
  // No other server module knows the provider.
  const walk = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`],
    );
  const outside = [...walk('src'), ...walk('scripts')].filter(
    (f) =>
      !f.startsWith(dir) && readFileSync(f, 'utf8').includes('clickup.com'),
  );
  expect(outside).toEqual([]);
});
test('nothing economic leaves: the only query parameters are the fixed read options', async () => {
  await linked([task('q1')]);
  await sync();
  const keys = new Set(seen.flatMap((r) => [...r.url.searchParams.keys()]));
  expect([...keys].sort()).toEqual(
    [
      'archived',
      'include_closed',
      'include_timl',
      'order_by',
      'page',
      'subtasks',
    ].sort(),
  );
  const q = seen.find((r) => r.url.pathname.endsWith('/task'))!.url
    .searchParams;
  expect(q.get('include_timl')).toBe('true');
  expect(q.get('include_closed')).toBe('true');
  expect(q.get('subtasks')).toBe('true');
});

// ---- Configuration ----
test('missing token, partial settings or the default keep the integration off', () => {
  const full = {
    CLICKUP_ENABLED: 'true',
    CLICKUP_API_TOKEN: TOKEN,
    CLICKUP_ORGANIZATION_ID: org,
    CLICKUP_WORKSPACE_ID: WORKSPACE,
  };
  expect(clickupWorkerConfig({})).toEqual({ enabled: false, reason: 'off' });
  expect(clickupWorkerConfig({ ...full, CLICKUP_ENABLED: 'false' })).toEqual({
    enabled: false,
    reason: 'off',
  });
  for (const token of [undefined, '', '   '])
    expect(clickupWorkerConfig({ ...full, CLICKUP_API_TOKEN: token })).toEqual({
      enabled: false,
      reason: 'missing_token',
    });
  for (const change of [
    { CLICKUP_ORGANIZATION_ID: 'x' },
    { CLICKUP_WORKSPACE_ID: 'abc' },
    { CLICKUP_REQUESTS_PER_MINUTE: '0' },
    { CLICKUP_SYNC_MINUTES: 'often' },
  ])
    expect(clickupWorkerConfig({ ...full, ...change })).toEqual({
      enabled: false,
      reason: 'invalid_config',
    });
  expect(clickupWorkerConfig(full)).toMatchObject({
    enabled: true,
    workspaceId: WORKSPACE,
    requestsPerMinute: 60,
    syncMinutes: 15,
  });
  expect(clickupOrganization({})).toBeUndefined();
  expect(
    clickupOrganization({
      CLICKUP_ENABLED: 'true',
      CLICKUP_ORGANIZATION_ID: 'no',
    }),
  ).toBeUndefined();
  expect(loadConfig({}).clickupOrganizationId).toBeUndefined();
  expect(
    loadConfig({ CLICKUP_ENABLED: 'true', CLICKUP_ORGANIZATION_ID: org })
      .clickupOrganizationId,
  ).toBe(org);
});
test('the real worker without a token exits cleanly before any database or network use', async () => {
  const p = Bun.spawn(
    [
      'node_modules/.bin/bun',
      '--no-env-file',
      'scripts/clickup-worker.ts',
      '--once',
    ],
    {
      env: {
        PATH: process.env.PATH!,
        CLICKUP_ENABLED: 'true',
        CLICKUP_ORGANIZATION_ID: org,
        CLICKUP_WORKSPACE_ID: WORKSPACE,
        // Unreachable on purpose: touching it would fail the process.
        CLICKUP_WORKER_DATABASE_URL: 'postgres://nobody:x@127.0.0.1:1/none',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  expect(await p.exited).toBe(0);
  expect(await new Response(p.stdout).text()).toContain(
    'disabled (missing_token)',
  );
});
const workerRun = async (env: Record<string, string>) => {
  const p = Bun.spawn(
    [
      'node_modules/.bin/bun',
      '--no-env-file',
      'scripts/clickup-worker.ts',
      '--once',
    ],
    {
      env: {
        PATH: process.env.PATH!,
        CLICKUP_ENABLED: 'true',
        CLICKUP_API_TOKEN: TOKEN,
        CLICKUP_ORGANIZATION_ID: org,
        CLICKUP_WORKSPACE_ID: WORKSPACE,
        ...env,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const code = await p.exited;
  return {
    code,
    out:
      (await new Response(p.stdout).text()) +
      (await new Response(p.stderr).text()),
  };
};
test('the real worker accepts its own account with nothing due, and refuses a stronger one', async () => {
  // Every list is not due (beforeEach), so this makes no call to the real provider.
  const fine = await workerRun({ CLICKUP_WORKER_DATABASE_URL: workerUrl });
  expect(fine.out).toContain('0 list(s) processed');
  expect(fine.code).toBe(0);
  expect(fine.out).not.toContain(TOKEN);
  const strong = await workerRun({ CLICKUP_WORKER_DATABASE_URL: runtimeUrl });
  expect(strong.code).not.toBe(0);
  expect(strong.out).toContain('overprivileged');
  expect(strong.out).not.toContain(TOKEN);
  const mixed = await workerRun({
    CLICKUP_WORKER_DATABASE_URL: workerUrl,
    RUNTIME_DATABASE_URL: runtimeUrl,
  });
  expect(mixed.code).not.toBe(0);
  expect(mixed.out).toContain('isolated');
});
test('activating twice and migrating again keep the account and its limits', async () => {
  const again = await provisionClickupRole(target.href, roleFile);
  expect(again.CLICKUP_WORKER_DATABASE_URL).toBe(workerUrl);
  expect(
    readFileSync(roleFile, 'utf8').match(/CLICKUP_WORKER_DATABASE_URL=/g),
  ).toHaveLength(1);
  const p = Bun.spawn(['node_modules/.bin/bun', 'scripts/migrate.ts'], {
    env: {
      ...process.env,
      ...roleEnv,
      DB_CLICKUP_WORKER_ROLE: name + '_clickup',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  expect(await p.exited).toBe(0);
  await workerDb.query('SELECT 1 FROM clickup_tasks LIMIT 1');
  await expect(
    workerDb.query('SELECT 1 FROM requests LIMIT 1'),
  ).rejects.toThrow();
  await runtime.query('SELECT 1 FROM clickup_tasks LIMIT 1');
});
test('launchers: web and AI worker never get the token; the ClickUp worker gets only its own', async () => {
  const code = `import {runtimeEnvironment as r,workerEnvironment as w,clickupWorkerEnvironment as c} from './scripts/runtime.mjs';
const base={CLICKUP_API_TOKEN:'t',OIDC_CLIENT_SECRET:'o',LLM_API_KEY:'l',DATABASE_URL:'admin',RUNTIME_DATABASE_URL:'run',AI_WORKER_DATABASE_URL:'ai',MIGRATION_DATABASE_URL:'m',CLICKUP_WORKER_DATABASE_URL:'cu',CLICKUP_ENABLED:'true'};
console.log(JSON.stringify({web:r(base,{},{}),ai:w(base,{},{}),cu:c(base,{},{})}));`;
  const child = Bun.spawn(['node', '--input-type=module', '-e', code], {
    stdout: 'pipe',
  });
  const env = JSON.parse(await new Response(child.stdout).text());
  expect(await child.exited).toBe(0);
  expect(env.web.CLICKUP_API_TOKEN).toBeUndefined();
  expect(env.web.CLICKUP_WORKER_DATABASE_URL).toBeUndefined();
  expect(env.web.CLICKUP_ENABLED).toBe('true');
  expect(env.ai.CLICKUP_API_TOKEN).toBeUndefined();
  expect(env.cu).toEqual({
    CLICKUP_API_TOKEN: 't',
    CLICKUP_WORKER_DATABASE_URL: 'cu',
    CLICKUP_ENABLED: 'true',
  });
});

// ---- Parsing ----
test('valid ids and dates are read correctly: the defect of the external branch does not exist here', () => {
  const w = { count: 0 };
  // Date strings and numbers, the documented form.
  expect(parseDate('1567780450202', w)).toBe('2019-09-06T14:34:10.202Z');
  expect(parseDate(1567780450202, w)).toBe('2019-09-06T14:34:10.202Z');
  expect(parseDate(null, w)).toBeNull();
  expect(w.count).toBe(0);
  const t = parseTask(
    task('9hx', {
      due_date: '1508369194377',
      due_date_time: true,
      assignees: [{ id: 2772463, username: 'Pessoa', email: 'a@b.test' }],
      status: { status: ' Aguardando Cliente ', type: 'custom' },
    }),
    WORKSPACE,
    w,
  );
  expect(t).toMatchObject({
    id: '9hx',
    status: 'Aguardando Cliente',
    statusType: 'custom',
    dueAt: '2017-10-18T23:26:34.377Z',
    dueHasTime: true,
    assignees: [{ id: '2772463', name: 'Pessoa' }],
  });
  // Nothing beyond the kept fields, so no e-mail travels on.
  expect(JSON.stringify(t)).not.toContain('a@b.test');
  expect(w.count).toBe(0);
});
test('a bad optional field is a counted warning, a bad identity fails the whole read', () => {
  for (const bad of ['amanhã', '-5', '123', 99999999999999, {}, true]) {
    const w = { count: 0 };
    expect(parseDate(bad, w)).toBeNull();
    expect(w.count).toBe(1);
  }
  const w = { count: 0 };
  const t = parseTask(
    task('b1', {
      url: 'javascript:alert(1)',
      status: 'quebrado',
      assignees: 'ninguém',
      dependencies: 'x',
    }),
    WORKSPACE,
    w,
  );
  expect(t.url).toBeNull();
  expect(t.statusType).toBe('unknown');
  expect(t.waitingOn).toBeNull();
  expect(w.count).toBeGreaterThanOrEqual(4);
  for (const broken of [{ name: 'sem id' }, { id: '../etc' }, null, 'x'])
    expect(() => parseTask(broken, WORKSPACE, { count: 0 })).toThrow(
      ClickUpError,
    );
  for (const page of [null, {}, { tasks: 'x' }])
    expect(() => parseTaskPage(page, WORKSPACE, { count: 0 })).toThrow(
      ClickUpError,
    );
  // Both documented shapes of assignees and dependencies.
  const shapes = parseTask(
    task('s1', {
      assignees: ['77'],
      dependencies: [
        { task_id: 's1', depends_on: 'a1' },
        { task_id: 'z9', depends_on: 's1' },
        'a2',
      ],
    }),
    WORKSPACE,
    { count: 0 },
  );
  expect(shapes.assignees).toEqual([{ id: '77', name: null }]);
  expect(shapes.waitingOn).toEqual(['a1', 'a2']);
});

// ---- Synchronization ----
test('pagination reads every page, and custom statuses go through untouched', async () => {
  const items = Array.from({ length: 5 }, (_, i) =>
    task('p' + i, {
      status: { status: 'Homologação Interna ' + i, type: 'custom' },
    }),
  );
  const { linkId, projectId } = await linked(items);
  expect((await sync()).processed).toBe(1);
  const run = await lastRun(linkId);
  expect(run).toMatchObject({
    state: 'succeeded',
    pages: 3,
    tasks_seen: 5,
    tasks_inserted: 5,
    tasks_updated: 0,
    http_calls: 4,
    error_code: null,
    source: 'clickup_api_v2',
  });
  expect(run.finished_at).not.toBeNull();
  expect(
    seen
      .filter((r) => r.url.pathname.endsWith('/task'))
      .map((r) => r.url.searchParams.get('page')),
  ).toEqual(['0', '1', '2']);
  const e = await execution(projectId);
  expect(e.freshness).toBe('fresh');
  expect(e.counts!.tasks_open).toBe(5);
  expect(e.unmapped_statuses.map((s) => s.status)).toContain(
    'Homologação Interna 3',
  );
  const stored = await db.query(
    'SELECT status_raw,status_type FROM clickup_tasks WHERE task_id=$1',
    ['p3'],
  );
  expect(stored.rows[0]).toEqual({
    status_raw: 'Homologação Interna 3',
    status_type: 'custom',
  });
});
test('a task in several lists is one task, in one project or across projects', async () => {
  const shared = task('multi1');
  const a = await linked([shared, task('only-a')]);
  const b = await linked([shared]);
  const sameProjectList = String(nextList++);
  lists.set(sameProjectList, [shared]);
  await link(a.projectId, sameProjectList);
  await sync();
  expect(
    Number(
      (
        await db.query(
          "SELECT count(*) FROM clickup_tasks WHERE task_id='multi1'",
        )
      ).rows[0].count,
    ),
  ).toBe(1);
  expect(
    Number(
      (
        await db.query(
          "SELECT count(*) FROM clickup_list_tasks WHERE task_id='multi1'",
        )
      ).rows[0].count,
    ),
  ).toBe(3);
  expect((await execution(a.projectId)).counts!.tasks_open).toBe(2);
  expect((await execution(b.projectId)).counts!.tasks_open).toBe(1);
});
test('repeating a sync adds nothing and rewrites nothing; a real change updates one row', async () => {
  const items = [task('r1'), task('r2'), task('r3')];
  const { linkId, listId, projectId } = await linked(items);
  await sync();
  const counts = async () =>
    (
      await db.query(
        "SELECT (SELECT count(*) FROM clickup_tasks WHERE task_id IN ('r1','r2','r3'))::int t,(SELECT count(*) FROM clickup_list_tasks WHERE link_id=$1)::int m,(SELECT max(synced_at) FROM clickup_tasks WHERE task_id IN ('r1','r2','r3')) s",
        [linkId],
      )
    ).rows[0];
  const first = await counts();
  await makeDue();
  await sync();
  expect(await lastRun(linkId)).toMatchObject({
    state: 'succeeded',
    tasks_seen: 3,
    tasks_inserted: 0,
    tasks_updated: 0,
    tasks_missing: 0,
  });
  expect(await counts()).toEqual(first);
  lists.set(listId, [
    task('r1', {
      date_updated: '1767225700000',
      status: { status: 'done', type: 'closed' },
    }),
    items[1],
    items[2],
  ]);
  await makeDue();
  await sync();
  expect(await lastRun(linkId)).toMatchObject({
    tasks_inserted: 0,
    tasks_updated: 1,
  });
  expect((await execution(projectId)).counts).toMatchObject({
    tasks_open: 2,
    tasks_closed: 1,
  });
});
test('an older answer never replaces a newer one', async () => {
  const { listId } = await linked([
    task('old1', { date_updated: '1767225700000', name: 'Mais nova' }),
  ]);
  await sync();
  lists.set(listId, [
    task('old1', { date_updated: '1767225600000', name: 'Antiga' }),
  ]);
  await makeDue();
  await sync();
  expect(
    (await db.query("SELECT name FROM clickup_tasks WHERE task_id='old1'"))
      .rows[0].name,
  ).toBe('Mais nova');
});
for (const [label, reply, code, status] of [
  [
    'HTTP 429',
    () =>
      new Response('{}', {
        status: 429,
        headers: {
          'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 3000),
        },
      }),
    'rate_limited',
    429,
  ],
  ['HTTP 500', () => new Response('segredo', { status: 500 }), 'upstream', 500],
  [
    'HTTP 401',
    () => new Response('{"ECODE":"x"}', { status: 401 }),
    'unauthorized',
    401,
  ],
  [
    'JSON inválido',
    () => new Response('<html>', { status: 200 }),
    'invalid_response',
    200,
  ],
] as [string, () => Response, string, number][])
  test(`${label} on a later page loses nothing, replaces nothing and shows old data as old`, async () => {
    const items = [task('f1'), task('f2'), task('f3')];
    const { linkId, projectId, listId } = await linked(items);
    await sync();
    const before = await execution(projectId);
    expect(before.counts!.tasks_open).toBe(3);
    const snapshot = async () =>
      (
        await db.query(
          'SELECT task_id,missing_since FROM clickup_list_tasks WHERE link_id=$1 ORDER BY task_id',
          [linkId],
        )
      ).rows;
    const stored = await snapshot();
    // A read that would make f3 vanish and rename f1 if half of it were applied.
    lists.set(listId, [
      task('f1', { name: 'Parcial', date_updated: '1767225900000' }),
      task('f2'),
    ]);
    pageSize = 1;
    await makeDue();
    failAfterPages(1, reply);
    const result = await sync();
    const run = await lastRun(linkId);
    expect(run).toMatchObject({
      state: 'failed',
      error_code: code,
      http_status: status,
    });
    expect(await snapshot()).toEqual(stored);
    expect(
      (await db.query("SELECT name FROM clickup_tasks WHERE task_id='f1'"))
        .rows[0].name,
    ).toBe('Tarefa f1');
    const after = await execution(projectId);
    expect(after.freshness).toBe('failing');
    expect(after.counts).toEqual(before.counts);
    expect(after.last_sync_at).toBe(before.last_sync_at);
    expect(after.links[0]!.last_error_code).toBe(code);
    const next = (
      await db.query(
        'SELECT next_sync_at,consecutive_failures FROM clickup_project_links WHERE id=$1',
        [linkId],
      )
    ).rows[0];
    expect(next.consecutive_failures).toBe(1);
    if (code === 'rate_limited') {
      expect(result.pauseSeconds).toBeGreaterThan(2900);
      expect(new Date(next.next_sync_at).getTime()).toBeGreaterThan(
        Date.now() + 2900000,
      );
    }
  });
test('a rate limit stops the cycle: the next list is not requested with the same token', async () => {
  const a = await linked([task('stop1')]);
  const b = await linked([task('stop2')]);
  fault = (url) =>
    url.pathname.endsWith('/task')
      ? new Response('{}', { status: 429 })
      : new Response('', { status: 299 });
  const result = await sync();
  expect(result.processed).toBe(1);
  expect(result.pauseSeconds).toBe(60);
  expect((await lastRun(a.linkId)).error_code).toBe('rate_limited');
  expect(await lastRun(b.linkId)).toBeUndefined();
});
test('a failure before the first read shows "not available", never zero', async () => {
  const { projectId, linkId } = await linked([task('n1')]);
  fault = () => new Response('', { status: 503 });
  await sync();
  const e = await execution(projectId);
  expect(e.freshness).toBe('never_synced');
  expect(e.counts).toBeNull();
  expect(e.situation).toBe('unavailable');
  expect(e.last_sync_at).toBeNull();
  expect((await lastRun(linkId)).error_code).toBe('upstream');
  const raw = JSON.stringify(e);
  expect(raw).not.toContain('tasks_open');
});
test('one list never read makes the whole project unknown, not a smaller number', async () => {
  const a = await linked([task('u1')]);
  await sync();
  expect((await execution(a.projectId)).counts!.tasks_open).toBe(1);
  await link(a.projectId, '999999');
  fault = () => new Response('', { status: 503 });
  await sync();
  const e = await execution(a.projectId);
  expect(e.freshness).toBe('never_synced');
  expect(e.counts).toBeNull();
});
test('network failure, timeout and a foreign workspace are recorded and change nothing', async () => {
  const dead = createClickUpClient({
    token: TOKEN,
    requestsPerMinute: 600000,
    baseUrl: 'http://127.0.0.1:1',
  });
  const n = await linked([task('net1')]);
  await sync(dead);
  expect((await lastRun(n.linkId)).error_code).toBe('network');
  const t = await linked([task('slow1')]);
  fault = async () => {
    await Bun.sleep(300);
    return new Response('', { status: 299 });
  };
  const slow = createClickUpClient({
    token: TOKEN,
    requestsPerMinute: 600000,
    baseUrl: `http://127.0.0.1:${fake.port}`,
    timeoutMs: 50,
  });
  await db.query(
    "UPDATE clickup_project_links SET next_sync_at=now()+interval '1 day' WHERE id<>$1",
    [t.linkId],
  );
  await sync(slow);
  expect((await lastRun(t.linkId)).error_code).toBe('timeout');
  fault = null;
  const f = await linked([task('other1', { team_id: '111' }), task('mine1')]);
  await sync();
  expect((await lastRun(f.linkId)).error_code).toBe('workspace_mismatch');
  expect(
    (
      await db.query(
        "SELECT count(*) FROM clickup_tasks WHERE task_id IN ('other1','mine1')",
      )
    ).rows[0].count,
  ).toBe('0');
});
test('an endless provider stops at the page limit and writes nothing', async () => {
  const { linkId } = await linked([]);
  fault = (url) =>
    url.pathname.endsWith('/task')
      ? Response.json({ tasks: [task('loop1')], last_page: false })
      : new Response('', { status: 299 });
  await sync();
  const run = await lastRun(linkId);
  expect(run.error_code).toBe('too_many_pages');
  expect(run.http_calls).toBe(MAX_PAGES + 1);
  expect(
    (await db.query("SELECT count(*) FROM clickup_tasks WHERE task_id='loop1'"))
      .rows[0].count,
  ).toBe('0');
});
test('reconciliation: only a complete read marks a task absent, and it comes back when seen', async () => {
  const items = [task('c1'), task('c2')];
  const { linkId, listId, projectId } = await linked(items);
  await sync();
  lists.set(listId, [items[0]]);
  await makeDue();
  await sync();
  expect((await lastRun(linkId)).tasks_missing).toBe(1);
  let e = await execution(projectId);
  expect(e.counts!.tasks_open).toBe(1);
  expect(e.removed_from_lists).toBe(1);
  // Kept, not deleted.
  expect(
    (await db.query("SELECT count(*) FROM clickup_tasks WHERE task_id='c2'"))
      .rows[0].count,
  ).toBe('1');
  lists.set(listId, items);
  await makeDue();
  await sync();
  e = await execution(projectId);
  expect(e.counts!.tasks_open).toBe(2);
  expect(e.removed_from_lists).toBe(0);
});
test('concurrent workers cannot run one list twice; an abandoned run expires', async () => {
  const { linkId } = await linked([task('k1')]);
  const claims = await Promise.all(
    Array.from({ length: 6 }, () => claimDueLink(workerDb, org)),
  );
  expect(claims.filter(Boolean)).toHaveLength(1);
  expect(await claimDueLink(workerDb, org)).toBeNull();
  await db.query(
    "UPDATE clickup_sync_runs SET lease_until=now()-interval '1 second' WHERE link_id=$1",
    [linkId],
  );
  const again = await claimDueLink(workerDb, org);
  expect(again?.link_id).toBe(linkId);
  expect(
    (
      await db.query(
        "SELECT count(*) FROM clickup_sync_runs WHERE link_id=$1 AND state='failed' AND error_code='lease_expired'",
        [linkId],
      )
    ).rows[0].count,
  ).toBe('1');
  await syncClaimed(workerDb, client(), again!, syncOptions);
  expect((await lastRun(linkId)).state).toBe('succeeded');
});
test('the largest list allowed fits the database time limits, and the panel still answers', async () => {
  const items = Array.from({ length: 20000 }, (_, i) =>
    task('big' + i, {
      assignees: [{ id: (i % 40) + 1, username: 'P' + (i % 40) }],
    }),
  );
  const { linkId, projectId } = await linked(items);
  pageSize = 100;
  await sync();
  expect(await lastRun(linkId)).toMatchObject({
    state: 'succeeded',
    tasks_seen: 20000,
    pages: 200,
  });
  await makeDue();
  await sync();
  expect(await lastRun(linkId)).toMatchObject({
    state: 'succeeded',
    tasks_updated: 0,
  });
  const started = Date.now();
  const e = await execution(projectId);
  console.log('overview with 20000 tasks:', Date.now() - started, 'ms');
  expect(e.counts!.tasks_open).toBe(20000);
  // Keep the other tests' reads small.
  await call('manager', `clickup/links/${linkId}/deactivate`, 'POST', {});
}, 60000);
test('a link removed while its list is being read receives nothing', async () => {
  const { linkId } = await linked([task('d1')]);
  const claim = await claimDueLink(workerDb, org);
  await call('manager', `clickup/links/${linkId}/deactivate`, 'POST', {});
  await syncClaimed(workerDb, client(), claim!, syncOptions);
  expect((await lastRun(linkId)).error_code).toBe('link_deactivated');
  expect(
    (await db.query("SELECT count(*) FROM clickup_tasks WHERE task_id='d1'"))
      .rows[0].count,
  ).toBe('0');
  // Never picked up again.
  await makeDue();
  seen.length = 0;
  await sync();
  expect(seen.filter((r) => r.url.pathname.includes(linkId))).toHaveLength(0);
});
test('tokens and provider bodies stay out of errors and stored records', async () => {
  const secret = 'corpo-sensivel-' + randomBytes(4).toString('hex');
  const { linkId } = await linked([task('s1x')]);
  fault = () => new Response(secret, { status: 500 });
  const logs: unknown[][] = [];
  const original = { log: console.log, error: console.error };
  console.log = (...a) => logs.push(a);
  console.error = (...a) => logs.push(a);
  try {
    await sync();
  } finally {
    Object.assign(console, original);
  }
  const everything = JSON.stringify([
    logs,
    (await db.query('SELECT * FROM clickup_sync_runs')).rows,
    (await db.query('SELECT * FROM clickup_project_links')).rows,
  ]);
  expect(everything).not.toContain(TOKEN);
  expect(everything).not.toContain(secret);
  expect((await lastRun(linkId)).error_code).toBe('upstream');
  let caught: unknown;
  try {
    await client().getList('424242');
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(ClickUpError);
  const text =
    JSON.stringify(caught) + String(caught) + (caught as Error).stack;
  expect(text).not.toContain(TOKEN);
  expect(text).not.toContain('424242');
});
test('a redirect is refused, so the token cannot follow it elsewhere', async () => {
  let elsewhere = 0;
  const other = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      elsewhere++;
      return Response.json({ id: '1', name: 'x' });
    },
  });
  try {
    fault = () =>
      new Response('', {
        status: 302,
        headers: { Location: `http://127.0.0.1:${other.port}/` },
      });
    await expect(client().getList('1')).rejects.toBeInstanceOf(ClickUpError);
    expect(elsewhere).toBe(0);
  } finally {
    other.stop(true);
  }
});
test('calls are spaced to the limit, and an exhausted window is waited for', async () => {
  let clock = 1_000_000;
  const waits: number[] = [];
  let remaining: string | null = null;
  const stub = createClickUpClient({
    token: TOKEN,
    requestsPerMinute: 60,
    now: () => clock,
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
    fetch: (async () =>
      Response.json(
        { id: '1' },
        {
          headers: remaining
            ? {
                'X-RateLimit-Remaining': remaining,
                'X-RateLimit-Reset': String(clock / 1000 + 30),
              }
            : {},
        },
      )) as unknown as typeof fetch,
  });
  await stub.getList('1');
  await stub.getList('1');
  await stub.getList('1');
  expect(waits).toEqual([1000, 1000]);
  remaining = '0';
  await stub.getList('1');
  waits.length = 0;
  await stub.getList('1');
  expect(waits).toEqual([30000]);
});

// ---- Reading rules ----
const row = (extra = {}) => ({
  task_id: 't',
  name: 't',
  url: null,
  parent_task_id: null,
  status_raw: 'x',
  status_type: 'custom',
  assignee_ids: [],
  waiting_on: [],
  due_at: null,
  due_has_time: false,
  ...extra,
});
test('overdue: a dated-only deadline gets the whole day; closed or undated tasks are never late', () => {
  const now = new Date('2026-11-05T12:00:00Z');
  expect(
    isOverdue(row({ due_at: '2026-11-05T11:59:00Z', due_has_time: true }), now),
  ).toBe(true);
  expect(
    isOverdue(row({ due_at: '2026-11-05T12:01:00Z', due_has_time: true }), now),
  ).toBe(false);
  expect(isOverdue(row({ due_at: '2026-11-05T04:00:00Z' }), now)).toBe(false);
  expect(isOverdue(row({ due_at: '2026-11-04T04:00:00Z' }), now)).toBe(true);
  expect(isOverdue(row(), now)).toBe(false);
  expect(
    isOverdue(
      row({ due_at: '2026-01-01T00:00:00Z', status_type: 'closed' }),
      now,
    ),
  ).toBe(false);
});
test('freshness turns stale by age, and stale data keeps its real numbers, not zeros', () => {
  const now = new Date('2026-11-05T12:00:00Z');
  const at = (minutes: number) =>
    new Date(now.getTime() - minutes * 60000).toISOString();
  const l = (success: string | null, error: string | null = null) => ({
    id: 'l',
    list_id: '1',
    list_name: null,
    last_success_at: success,
    last_attempt_at: null,
    last_error_code: error,
  });
  expect(freshnessOf([], now)).toBe('not_linked');
  expect(freshnessOf([l(null)], now)).toBe('never_synced');
  expect(freshnessOf([l(at(5))], now)).toBe('fresh');
  expect(freshnessOf([l(at(STALE_AFTER_MINUTES + 1))], now)).toBe('stale');
  expect(freshnessOf([l(at(5), 'upstream')], now)).toBe('failing');
  const s = summarize(
    [l(at(600))],
    [row()],
    new Map(),
    new Map(),
    { removed_from_lists: 0, data_warnings: 0 },
    now,
  );
  expect(s.freshness).toBe('stale');
  expect(s.counts!.tasks_open).toBe(1);
  expect(s.last_sync_at).toBe(at(600));
  const none = summarize(
    [],
    [],
    new Map(),
    new Map(),
    { removed_from_lists: 0, data_warnings: 0 },
    now,
  );
  expect(none).toMatchObject({
    counts: null,
    situation: 'unavailable',
    last_sync_at: null,
  });
});
test('the panel figures: owners, overdue, dependencies, subtasks; no percentage or forecast', async () => {
  const past = String(Date.now() - 3 * 86400000),
    future = String(Date.now() + 3 * 86400000);
  const { projectId } = await linked([
    task('v1', {
      due_date: past,
      assignees: [{ id: 1, username: 'Ana' }],
      url: 'https://app.clickup.com/t/v1',
    }),
    task('v2', {
      due_date: future,
      assignees: [
        { id: 1, username: 'Ana' },
        { id: 2, username: 'Bia' },
      ],
      dependencies: [{ task_id: 'v2', depends_on: 'v1' }],
    }),
    task('v3', { dependencies: [{ task_id: 'v3', depends_on: 'v4' }] }),
    task('v4', {
      status: { status: 'Entregue', type: 'closed' },
      date_done: past,
    }),
    task('v5', { parent: 'v1', due_date: past }),
    task('v6', { parent: 'v1', status: { status: 'done', type: 'done' } }),
  ]);
  pageSize = 100;
  await sync();
  const e = await execution(projectId);
  expect(e.counts).toMatchObject({
    tasks_open: 3,
    tasks_closed: 1,
    subtasks_open: 1,
    subtasks_closed: 1,
    overdue: 2,
    without_due_date: 1,
    unassigned_open: 2,
    waiting_dependency: 1,
    blocked: null,
    waiting_client: null,
  });
  expect(e.situation).toBe('overdue');
  expect(e.owners).toEqual([
    { name: 'Ana', open: 2, overdue: 1 },
    { name: 'Bia', open: 1, overdue: 0 },
  ]);
  expect(e.attention.map((a) => a.id).sort()).toEqual(['v1', 'v5']);
  expect(new Date(e.counts!.next_due_at!).getTime()).toBe(Number(future));
  expect(JSON.stringify(e)).not.toMatch(
    /percent|forecast|progress|margin|cost/i,
  );
});
test('dependencies the provider did not send are unknown, not zero', async () => {
  const noDeps: Record<string, unknown> = task('nd1');
  delete noDeps.dependencies;
  const { projectId } = await linked([noDeps]);
  await sync();
  expect((await execution(projectId)).counts!.waiting_dependency).toBeNull();
});
test('blocked exists only through an explicit mapping, per organization and audited', async () => {
  const { projectId } = await linked([
    task('m1', { status: { status: 'Travado Agora', type: 'custom' } }),
    task('m2', { status: { status: 'Fazendo Agora', type: 'custom' } }),
  ]);
  await sync();
  let e = await execution(projectId);
  expect(e.counts!.blocked).toBeNull();
  expect(e.situation).toBe('no_known_delay');
  await call('manager', 'clickup/status-mappings', 'POST', {
    status: 'TRAVADO AGORA ',
    state: 'blocked',
  });
  e = await execution(projectId);
  expect(e.counts!.blocked).toBe(1);
  expect(e.situation).toBe('blocked');
  expect(e.unmapped_statuses).toEqual([{ status: 'Fazendo Agora', tasks: 1 }]);
  await call('admin', 'clickup/status-mappings', 'POST', {
    status: 'fazendo agora',
    state: 'in_progress',
  });
  e = await execution(projectId);
  expect(e.unmapped_statuses).toEqual([]);
  await call('manager', 'clickup/status-mappings', 'POST', {
    status: 'travado agora',
    state: 'in_progress',
  });
  e = await execution(projectId);
  // Everything mapped now, so this zero is known.
  expect(e.counts!.blocked).toBe(0);
  const audited = await db.query(
    "SELECT count(*) FROM audit_events WHERE entity_type='clickup_status_mapping' AND organization_id=$1 AND actor_user_id IS NOT NULL",
    [org],
  );
  expect(Number(audited.rows[0].count)).toBeGreaterThanOrEqual(3);
  expect(
    (
      await raw('manager', 'clickup/status-mappings', 'POST', {
        status: 'x',
        state: 'inventado',
      })
    ).status,
  ).toBe(422);
});

// ---- Access ----
test('links are validated and audited, and a list has one active project', async () => {
  const projectId = await newProject('valida');
  for (const list_id of ['abc', '12a', '', '1/../2', 12])
    expect(
      (
        await raw('manager', 'clickup/links', 'POST', {
          project_id: projectId,
          list_id,
        })
      ).status,
    ).toBe(422);
  const l = await link(projectId, '555001');
  expect(
    (
      await raw('admin', 'clickup/links', 'POST', {
        project_id: projectId,
        list_id: '555001',
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await db.query(
        "SELECT action,actor_user_id FROM audit_events WHERE entity_type='clickup_link' AND entity_id=$1",
        [l.id],
      )
    ).rows,
  ).toEqual([{ action: 'created', actor_user_id: users.manager }]);
  await call('admin', `clickup/links/${l.id}/deactivate`, 'POST', {});
  await link(projectId, '555001');
  expect(
    (await raw('manager', `clickup/links/${l.id}/deactivate`, 'POST', {}))
      .status,
  ).toBe(404);
});
test('another organization sees nothing and cannot reach or link anything', async () => {
  const mine = await linked([task('iso1')]);
  await sync();
  // Same external id in another tenant, seeded directly: separate rows, separate readers.
  const foreignClient = await call('foreign', 'clients', 'POST', {
    name: 'Fora',
  });
  const foreignProject = await call('foreign', 'projects', 'POST', {
    client_id: foreignClient.id,
    name: 'Projeto fora',
  });
  const foreignLink = (
    await db.query(
      'INSERT INTO clickup_project_links(organization_id,project_id,list_id,created_by,next_sync_at) VALUES($1,$2,$3,$4,now()) RETURNING id',
      [foreignOrg, foreignProject.id, '777001', users.foreign],
    )
  ).rows[0].id;
  await db.query(
    "INSERT INTO clickup_tasks(organization_id,task_id,name,status_raw,status_type) VALUES($1,'iso1','Da outra agência','x','custom')",
    [foreignOrg],
  );
  // The foreign manager has no integration at all.
  const seenByForeign = await call<FinancialOverview>('foreign', 'overview');
  expect(JSON.stringify(seenByForeign)).not.toContain('execution');
  for (const [path, method, body] of [
    ['clickup/sync-runs', 'GET', undefined],
    [
      'clickup/links',
      'POST',
      { project_id: foreignProject.id, list_id: '777002' },
    ],
    ['clickup/status-mappings', 'POST', { status: 'x', state: 'blocked' }],
    [`clickup/links/${mine.linkId}/deactivate`, 'POST', {}],
  ] as const)
    expect((await raw('foreign', path, method, body)).status).toBe(404);
  // Linking a project of another organization fails by constraint, not by luck.
  expect(
    (
      await raw('manager', 'clickup/links', 'POST', {
        project_id: foreignProject.id,
        list_id: '777003',
      })
    ).status,
  ).toBe(422);
  // The worker is bound to its organization: the foreign list is never requested.
  lists.set('777001', [task('leak1')]);
  seen.length = 0;
  await sync();
  expect(seen.filter((r) => r.url.pathname.includes('777001'))).toHaveLength(0);
  expect(
    (
      await db.query(
        'SELECT last_attempt_at FROM clickup_project_links WHERE id=$1',
        [foreignLink],
      )
    ).rows[0].last_attempt_at,
  ).toBeNull();
  // And this organization reads its own row of the same id.
  const e = await execution(mine.projectId);
  expect(e.counts!.tasks_open).toBe(1);
  const runs = await call<{ link_id: string }[]>(
    'manager',
    'clickup/sync-runs',
  );
  expect(runs.map((r) => r.link_id)).not.toContain(foreignLink);
  expect(runs.length).toBeGreaterThan(0);
});
test('PO and developer get nothing new: no execution in their reading, 403 on the routes', async () => {
  await linked([task('role1')]);
  await sync();
  for (const who of ['po', 'dev']) {
    const res = await raw(who, 'overview');
    // A 500 would also contain no execution: the reading itself must work.
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text).kind).toBe(
      who === 'po' ? 'operational' : 'personal',
    );
    expect(text).not.toContain('execution');
    expect(text).not.toContain('clickup');
    expect((await raw(who, 'clickup/sync-runs')).status).toBe(403);
    expect(
      (
        await raw(who, 'clickup/status-mappings', 'POST', {
          status: 'x',
          state: 'blocked',
        })
      ).status,
    ).toBe(403);
  }
  expect((await raw('admin', 'clickup/sync-runs')).status).toBe(200);
  expect((await raw('', 'clickup/sync-runs')).status).toBe(401);
});
test('integration off: same response as before, no routes, and the existing flows work', async () => {
  const projectId = await newProject('desligada');
  const on = await call<FinancialOverview>('manager', 'overview');
  expect(
    on.projects.find((p) => p.project_id === projectId)!.execution!.freshness,
  ).toBe('not_linked');
  const off = await (
    await raw('manager', 'overview', 'GET', undefined, appOff)
  ).json();
  expect(JSON.stringify(off)).not.toContain('execution');
  expect(
    off.projects.find((p: { project_id: string }) => p.project_id === projectId)
      .open_requests,
  ).toBe(0);
  for (const [path, method, body] of [
    ['clickup/sync-runs', 'GET', undefined],
    ['clickup/links', 'POST', { project_id: projectId, list_id: '1' }],
  ] as const)
    expect((await raw('manager', path, method, body, appOff)).status).toBe(404);
  const c = await (
    await raw('manager', 'clients', 'POST', { name: 'Fluxo normal' }, appOff)
  ).json();
  expect(c.id).toBeTruthy();
  // ClickUp tasks never become demands, on or off.
  expect(
    (
      await db.query(
        "SELECT count(*) FROM requests WHERE title LIKE 'Tarefa %'",
      )
    ).rows[0].count,
  ).toBe('0');
});
test('database accounts: worker reaches only its tables, web cannot write what the worker owns', async () => {
  const denied = async (pool: pg.Pool, sql: string) => {
    let code = '';
    try {
      await pool.query(sql);
    } catch (e) {
      code = (e as { code: string }).code;
    }
    expect([sql, code]).toEqual([sql, '42501']);
  };
  for (const table of [
    'economic_records',
    'economic_reports',
    'time_entries',
    'contracts',
    'requests',
    'users',
    'sessions',
    'audit_events',
    'clickup_status_mappings',
  ])
    await denied(workerDb, `SELECT 1 FROM ${table} LIMIT 1`);
  await denied(workerDb, 'UPDATE clickup_project_links SET active=false');
  await denied(workerDb, 'UPDATE clickup_people SET user_id=NULL');
  await denied(workerDb, 'DELETE FROM clickup_tasks');
  await denied(
    runtime,
    "INSERT INTO clickup_tasks(organization_id,task_id,name,status_raw,status_type) VALUES(gen_random_uuid(),'x','x','x','x')",
  );
  await denied(runtime, 'UPDATE clickup_tasks SET name=name');
  await denied(runtime, 'DELETE FROM clickup_sync_runs');
  await denied(
    runtime,
    'UPDATE clickup_project_links SET last_success_at=now()',
  );
});
