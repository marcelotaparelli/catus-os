// Rehearsal of the homologation upgrade in a disposable database: a schema at 012 with
// M6.1 data, then the real migration runner applies 013. Nothing existing may change.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import {
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  mkdirSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { provisionRoles } from '../scripts/lib/provision-roles';
import { provisionClickupRole } from '../scripts/lib/clickup-role';
import { ident } from '../scripts/lib/privileges';
import type { DatabaseRoles } from '../scripts/lib/provision-roles';
import { withExecution } from '../src/server/clickup/service';
import type { Context } from '../src/server/auth/policy';
import type { FinancialOverview } from '../src/shared/overview';
import type { ProjectExecution } from '../src/shared/clickup';
import { dropDisposableDatabase } from './support/disposable';

const name = `cuu_${randomBytes(4).toString('hex')}_test`;
const roleFile = resolve(`.local/clickup-${name}.env`);
const control = new URL(process.env.DATABASE_URL!);
control.pathname = '/postgres';
const target = new URL(control);
target.pathname = '/' + name;
const admin = new pg.Pool({ connectionString: control.href });
const org = crypto.randomUUID(),
  user = crypto.randomUUID(),
  project = crypto.randomUUID(),
  link = crypto.randomUUID(),
  run = crypto.randomUUID();
let db: pg.Pool, runtime: pg.Pool, worker: pg.Pool;
let roles: DatabaseRoles;
const scratch = mkdtempSync(join(tmpdir(), 'catus-upgrade-'));

/** The real runner, seeing only the migrations up to `last`. */
async function migrateUpTo(last: string) {
  const dir = join(scratch, last, 'db', 'migrations');
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync('db/migrations'))
    if (f.endsWith('.sql') && f <= last)
      symlinkSync(resolve('db/migrations', f), join(dir, f));
  const p = Bun.spawn(
    [resolve('node_modules/.bin/bun'), resolve('scripts/migrate.ts')],
    {
      cwd: join(scratch, last),
      env: {
        ...process.env,
        ...roles,
        DB_CLICKUP_WORKER_ROLE: name + '_clickup',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const code = await p.exited;
  if (code !== 0)
    throw new Error(
      'Migration failed: ' + (await new Response(p.stderr).text()),
    );
  return new Response(p.stdout).text();
}
const ctx = () =>
  ({
    db: runtime,
    organizationId: org,
    userId: user,
    role: 'manager',
    name: 'gestor',
  }) as unknown as Context;
async function panel(now = new Date()) {
  const overview = {
    kind: 'financial',
    projects: [{ project_id: project }],
  } as unknown as FinancialOverview;
  return (await withExecution(ctx(), org, overview, now)).projects[0]!
    .execution as ProjectExecution;
}
let at013: { columns: Record<string, unknown>[]; rows: object[][] } | null =
  null;
const linkRows = async () =>
  (
    (await db.query(
      'SELECT * FROM clickup_project_links ORDER BY id; SELECT * FROM clickup_sync_runs ORDER BY id',
    )) as unknown as pg.QueryResult[]
  ).map((r) => r.rows as object[]);
const columnsOf = async () =>
  (
    await db.query(
      "SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name LIKE 'clickup%' ORDER BY 1,2",
    )
  ).rows;

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${ident(name)}`);
  roles = await provisionRoles(target.href, roleFile);
  await provisionClickupRole(target.href, roleFile);
  db = new pg.Pool({ connectionString: target.href });
});
afterAll(async () => {
  await runtime?.end();
  await worker?.end();
  await db?.end();
  await dropDisposableDatabase(admin, name);
  for (const r of ['runtime', 'migrator', 'maintenance', 'aiworker', 'clickup'])
    await admin.query(`DROP ROLE IF EXISTS ${ident(name + '_' + r)}`);
  await admin.end();
  rmSync(roleFile, { force: true });
  rmSync(scratch, { recursive: true, force: true });
});

test('013 on top of M6.1 data: nothing existing changes, the panel reads the same, roles keep their limits', async () => {
  expect(await migrateUpTo('012_clickup_readonly.sql')).toContain(
    'Applied 012_clickup_readonly.sql',
  );
  // M6.1 data as its own code would have stored it: no home list, one org-wide mapping.
  await db.query('INSERT INTO organizations(id,name) VALUES($1,$2)', [
    org,
    'Agência sintética',
  ]);
  await db.query(
    "INSERT INTO users(id,issuer,email,display_name) VALUES($1,'https://idp.test','g@catus.test','gestor')",
    [user],
  );
  await db.query(
    "INSERT INTO memberships(user_id,organization_id,role) VALUES($1,$2,'manager')",
    [user, org],
  );
  const client = (
    await db.query(
      "INSERT INTO clients(id,organization_id,name) VALUES(gen_random_uuid(),$1,'Cliente') RETURNING id",
      [org],
    )
  ).rows[0].id;
  await db.query(
    "INSERT INTO projects(id,organization_id,client_id,name) VALUES($1,$2,$3,'Projeto')",
    [project, org, client],
  );
  await db.query(
    "INSERT INTO clickup_project_links(id,organization_id,project_id,list_id,list_name,created_by,last_success_at,last_attempt_at) VALUES($1,$2,$3,'4001','Lista piloto',$4,now(),now())",
    [link, org, project, user],
  );
  await db.query(
    "INSERT INTO clickup_sync_runs(id,organization_id,link_id,list_id,state,lease_until,finished_at) VALUES($1,$2,$3,'4001','succeeded',now(),now())",
    [run, org, link],
  );
  for (const [id, status, type] of [
    ['u1', 'Travado', 'custom'],
    ['u2', 'Fazendo', 'custom'],
    ['u3', 'Entregue', 'closed'],
  ]) {
    await db.query(
      'INSERT INTO clickup_tasks(organization_id,task_id,name,status_raw,status_type) VALUES($1,$2,$3,$4,$5)',
      [org, id, 'Tarefa ' + id, status, type],
    );
    await db.query(
      'INSERT INTO clickup_list_tasks(organization_id,link_id,task_id,last_seen_run_id) VALUES($1,$2,$3,$4)',
      [org, link, id, run],
    );
  }
  await db.query(
    "INSERT INTO clickup_status_mappings(organization_id,status_key,managerial_state,updated_by) VALUES($1,'travado','blocked',$2),($1,'fazendo','in_progress',$2)",
    [org, user],
  );
  const before = await columnsOf();
  const rowsBefore = (
    (await db.query(
      'SELECT * FROM clickup_tasks ORDER BY task_id; SELECT * FROM clickup_status_mappings ORDER BY status_key; SELECT * FROM clickup_list_tasks ORDER BY task_id',
    )) as unknown as pg.QueryResult[]
  ).map((r) => r.rows);

  const out = await migrateUpTo('013_clickup_status_scope.sql');
  expect(out).toContain('Applied 013_clickup_status_scope.sql');
  expect(out).not.toContain('Applied 012');
  runtime = new pg.Pool({ connectionString: roles.RUNTIME_DATABASE_URL });

  // Additive: every 012 column is identical; the only new column is nullable without default.
  const after = await columnsOf();
  const key = (c: Record<string, unknown>) =>
    `${c.table_name}.${c.column_name}`;
  const old = new Set(before.map(key));
  expect(after.filter((c) => old.has(key(c)))).toEqual(before);
  expect(
    after
      .filter((c) => !old.has(key(c)))
      .map(key)
      .sort(),
  ).toEqual([
    'clickup_list_status_mappings.id',
    'clickup_list_status_mappings.list_id',
    'clickup_list_status_mappings.managerial_state',
    'clickup_list_status_mappings.organization_id',
    'clickup_list_status_mappings.status_key',
    'clickup_list_status_mappings.updated_at',
    'clickup_list_status_mappings.updated_by',
    'clickup_tasks.home_list_id',
  ]);
  expect(
    after.find((c) => key(c) === 'clickup_tasks.home_list_id'),
  ).toMatchObject({ is_nullable: 'YES', column_default: null });
  const rowsAfter = (
    (await db.query(
      'SELECT * FROM clickup_tasks ORDER BY task_id; SELECT * FROM clickup_status_mappings ORDER BY status_key; SELECT * FROM clickup_list_tasks ORDER BY task_id',
    )) as unknown as pg.QueryResult[]
  ).map((r) => r.rows);
  expect(rowsAfter[0]).toEqual(
    rowsBefore[0]!.map((t: object) => ({ ...t, home_list_id: null })),
  );
  expect(rowsAfter.slice(1)).toEqual(rowsBefore.slice(1));

  // The current code needs 014 as well; the 013 schema was checked above and is kept for
  // the next test, which checks what 014 changes.
  at013 = { columns: after, rows: await linkRows() };
  const next = await migrateUpTo('014_clickup_task_links.sql');
  expect(next).toContain('Applied 014_clickup_task_links.sql');
  expect(next).not.toContain('Applied 013');

  // The same reading as M6.1: legacy org-wide mappings still apply, nothing unmapped.
  const e = await panel();
  expect(e.counts).toMatchObject({
    tasks_open: 2,
    tasks_closed: 1,
    blocked: 1,
    waiting_client: 0,
  });
  expect(e.situation).toBe('blocked');
  expect(e.unmapped_statuses).toEqual([]);

  // Rollback to the M6.1 code needs no down-migration: its statements still run as they were.
  await runtime.query(
    `INSERT INTO clickup_status_mappings(organization_id,status_key,managerial_state,updated_by) VALUES($1,$2,$3,$4)
 ON CONFLICT(organization_id,status_key) DO UPDATE SET managerial_state=excluded.managerial_state,updated_by=excluded.updated_by,updated_at=now() RETURNING id`,
    [org, 'fazendo', 'in_progress', user],
  );
  worker = new pg.Pool({
    connectionString: (await provisionClickupRole(target.href, roleFile))
      .CLICKUP_WORKER_DATABASE_URL,
  });
  await worker.query(
    "INSERT INTO clickup_tasks(organization_id,task_id,name,status_raw,status_type) VALUES($1,'u4','Tarefa u4','Fazendo','custom')",
    [org],
  );

  // Privileges after the upgrade: web manages list mappings, the worker cannot see them.
  let code = '';
  try {
    await worker.query('SELECT 1 FROM clickup_list_status_mappings');
  } catch (err) {
    code = (err as { code: string }).code;
  }
  expect(code).toBe('42501');
  for (const [sql, ok] of [
    ['SELECT 1 FROM clickup_list_status_mappings', true],
    ['DELETE FROM clickup_list_status_mappings', false],
    ['UPDATE clickup_tasks SET home_list_id=NULL', false],
  ] as const) {
    let failed = '';
    try {
      await runtime.query(sql);
    } catch (err) {
      failed = (err as { code: string }).code;
    }
    expect([sql, failed]).toEqual([sql, ok ? '' : '42501']);
  }
});
test('014 on top of 013 data: list links read the same, a link is a list or a task, never both', async () => {
  const before = at013!.columns,
    rowsBefore = at013!.rows;
  // Additive: list_id stops being mandatory (for task links only, see the check below), and
  // two nullable columns appear. Everything else is identical.
  const after = await columnsOf();
  const key = (c: Record<string, unknown>) =>
    `${c.table_name}.${c.column_name}`;
  const relaxed = [
    'clickup_project_links.list_id',
    'clickup_sync_runs.list_id',
  ];
  expect(
    after.filter(
      (c) => !relaxed.includes(key(c)) && before.some((b) => key(b) === key(c)),
    ),
  ).toEqual(before.filter((c) => !relaxed.includes(key(c))));
  for (const k of relaxed)
    expect(after.find((c) => key(c) === k)).toMatchObject({
      is_nullable: 'YES',
    });
  expect(
    after
      .filter((c) => !before.some((b) => key(b) === key(c)))
      .map((c) => [key(c), c.is_nullable, c.column_default]),
  ).toEqual([
    ['clickup_project_links.root_task_id', 'YES', null],
    ['clickup_sync_runs.root_task_id', 'YES', null],
  ]);
  const rowsAfter = await linkRows();
  expect(rowsAfter[0]).toEqual(
    rowsBefore[0]!.map((l: object) => ({ ...l, root_task_id: null })),
  );
  expect(rowsAfter[1]).toEqual(
    rowsBefore[1]!.map((r: object) => ({ ...r, root_task_id: null })),
  );
  // A list link has no root: every task stays an activity, as before.
  const e = await panel();
  expect(e.links.map((l) => [l.list_id, l.task_id])).toEqual([['4001', null]]);
  expect(e.roots).toEqual([]);

  // The previous code's insert of a list link still works; a link with neither or both fails.
  for (const [list, task, ok] of [
    ['4002', null, true],
    [null, 'abc123', true],
    [null, null, false],
    ['4003', 'abc124', false],
  ] as const) {
    let failed = '';
    try {
      await runtime.query(
        'INSERT INTO clickup_project_links(organization_id,project_id,list_id,root_task_id,created_by) VALUES($1,$2,$3,$4,$5)',
        [org, project, list, task, user],
      );
    } catch (err) {
      failed = (err as { code: string }).code;
    }
    expect([list, task, failed]).toEqual([list, task, ok ? '' : '23514']);
  }
  // One active link per top-level task in an organization.
  let duplicate = '';
  try {
    await runtime.query(
      "INSERT INTO clickup_project_links(organization_id,project_id,root_task_id,created_by) VALUES($1,$2,'abc123',$3)",
      [org, project, user],
    );
  } catch (err) {
    duplicate = (err as { code: string }).code;
  }
  expect(duplicate).toBe('23505');
  // The worker still cannot create or repoint links.
  let denied = '';
  try {
    await worker.query(
      "UPDATE clickup_project_links SET root_task_id='zzz' WHERE organization_id=$1",
      [org],
    );
  } catch (err) {
    denied = (err as { code: string }).code;
  }
  expect(denied).toBe('42501');
});
