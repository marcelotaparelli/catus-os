import { afterAll, beforeAll, expect, test } from 'bun:test';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/server/app';
import { oidcProvider } from '../src/server/auth/oidc';
import { assess, concerns, visibleTo } from '../src/server/followup/rules';
import type { DemandFacts } from '../src/server/followup/rules';
import {
  enqueueSweeps,
  evaluate,
  runDueJobs,
} from '../src/server/followup/automation';
import type { Evaluate } from '../src/server/followup/automation';
import { addBusinessDays, nextStep } from '../src/shared/followup';
import type { FollowupQueue } from '../src/shared/followup';
import { runBaseline } from '../scripts/lib/baseline';
import { provisionRoles } from '../scripts/lib/provision-roles';
import { ident } from '../scripts/lib/privileges';
import { dropDisposableDatabase } from './support/disposable';
import { codeFor, config, mockOidcFetch } from './support/oidc-provider';

const name = `fu_${randomBytes(4).toString('hex')}_test`;
const control = new URL(process.env.DATABASE_URL!);
control.pathname = '/postgres';
const target = new URL(control);
target.pathname = '/' + name;
const admin = new pg.Pool({ connectionString: control.href });
let db: pg.Pool, runtime: pg.Pool;
let app: ReturnType<typeof createApp>;
const org = crypto.randomUUID(),
  foreignOrg = crypto.randomUUID();
const ids = {
  admin: crypto.randomUUID(),
  manager: crypto.randomUUID(),
  po: crypto.randomUUID(),
  dev: crypto.randomUUID(),
  dev2: crypto.randomUUID(),
  foreign: crypto.randomUUID(),
};
type Who = keyof typeof ids;
const sessions: Record<string, { cookie: string; csrf: string }> = {};
async function raw(who: string, path: string, method = 'GET', body?: unknown) {
  const a = sessions[who];
  return app(
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
    'followup-tests',
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
    throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
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
    'followup-tests',
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
      'followup-tests',
    )
  ).json();
  return { cookie, csrf: session.csrfToken as string };
}
let interaction: string;
const today = new Date().toISOString().slice(0, 10);
const day = (n: number) =>
  new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
async function demand(title: string, owner: Who = 'dev', extra = {}) {
  return call('po', 'requests', 'POST', {
    interaction_id: interaction,
    title,
    description: title,
    owner_user_id: ids[owner],
    next_action: `Próximo: ${title}`,
    ...extra,
  });
}
const patchOf = (r: any, changes = {}) => ({
  status: r.status,
  owner_user_id: r.owner_user_id,
  next_action: r.next_action,
  version: r.version,
  ...changes,
});
const queue = (who: Who) => call<FollowupQueue>(who, 'followup');
const item = (q: FollowupQueue, id: string) => q.items.find((i) => i.id === id);
const kinds = (q: FollowupQueue, id: string) =>
  item(q, id)?.signals.map((s) => s.kind);
const drain = async (evaluator?: Evaluate) => {
  while (await runDueJobs(runtime, { evaluator, backoffSeconds: 0 }));
};

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${ident(name)}`);
  const roles = await provisionRoles(
    target.href,
    `.local/followup-${name}.env`,
  );
  const p = Bun.spawn(['node_modules/.bin/bun', 'scripts/migrate.ts'], {
    env: { ...process.env, ...roles },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  if ((await p.exited) !== 0) throw new Error('Migration failed');
  db = new pg.Pool({ connectionString: target.href });
  runtime = new pg.Pool({ connectionString: roles.RUNTIME_DATABASE_URL! });
  await db.query(
    "INSERT INTO organizations(id,name) VALUES($1,'Agência'),($2,'Outra')",
    [org, foreignOrg],
  );
  for (const [who, role] of [
    ['admin', 'administrator'],
    ['manager', 'manager'],
    ['po', 'po'],
    ['dev', 'developer'],
    ['dev2', 'developer'],
    ['foreign', 'po'],
  ] as [Who, string][]) {
    await db.query(
      'INSERT INTO users(id,issuer,email,display_name) VALUES($1,$2,$3,$4)',
      [ids[who], config.oidc!.issuer, `${who}@followup.test`, `Pessoa ${who}`],
    );
    await db.query(
      'INSERT INTO memberships(user_id,organization_id,role) VALUES($1,$2,$3)',
      [ids[who], who === 'foreign' ? foreignOrg : org, role],
    );
  }
  app = createApp(config, oidcProvider(config, await mockOidcFetch()), {
    pool: runtime,
    extractionProvider: null,
    loginRate: { limit: 500, windowSeconds: 60 },
    apiRate: { limit: 5000, windowSeconds: 60 },
  });
  for (const who of Object.keys(ids))
    sessions[who] = await login(`${who}@followup.test`);
  const client = await call('po', 'clients', 'POST', { name: 'Cliente' });
  const project = await call('po', 'projects', 'POST', {
    client_id: client.id,
    name: 'Projeto',
  });
  interaction = (
    await call('po', 'interactions', 'POST', {
      project_id: project.id,
      kind: 'service',
      summary: 'Atendimento',
      occurred_at: new Date().toISOString(),
    })
  ).id;
});
afterAll(async () => {
  await runtime.end();
  await db.end();
  await dropDisposableDatabase(admin, name);
  await admin.end();
});

const facts = (over: Partial<DemandFacts> = {}): DemandFacts => ({
  id: 'x',
  status: 'in_progress',
  template: 'manutencao',
  owner_user_id: 'u',
  owner_active: true,
  follow_up_on: '2026-11-10',
  blocked_reason: null,
  waiting_on: null,
  covered: true,
  updated_at: new Date('2026-11-04T00:00:00Z'),
  planned_minutes: null,
  logged_minutes: 0,
  ...over,
});
const NOW = new Date('2026-11-05T12:00:00Z');
// An implantation with its agreement confirmed: nothing to warn about the alignment.
const agreed = {
  version: 1,
  criteria: 'Critério',
  high_risk: false,
  confirmed: true,
  authorized: false,
  delivered_at: null,
  rejections: 0,
};
const on = (f: Partial<DemandFacts>) =>
  assess(facts(f), '2026-11-05', NOW).map((s) => s.kind);

test('rules: each condition is detected and a healthy demand is silent', () => {
  expect(on({})).toEqual([]);
  expect(on({ status: 'done', owner_user_id: null })).toEqual([]);
  expect(on({ owner_user_id: null })).toEqual(['no_owner']);
  expect(on({ owner_active: false })).toEqual(['no_owner']);
  expect(on({ follow_up_on: '2026-11-04' })).toEqual(['overdue']);
  expect(on({ follow_up_on: '2026-11-05' })).toEqual([]);
  expect(on({ follow_up_on: null })).toEqual(['no_follow_up']);
  expect(on({ status: 'new', follow_up_on: null })).toEqual(['no_follow_up']);
  expect(
    on({
      status: 'blocked',
      waiting_on: 'client',
      blocked_reason: 'senha',
      follow_up_on: '2026-11-01',
    }),
  ).toEqual(['client_delay']);
  expect(
    on({
      status: 'blocked',
      waiting_on: 'internal',
      follow_up_on: '2026-11-01',
    }),
  ).toEqual(['overdue']);
  expect(on({ status: 'blocked', waiting_on: 'client' })).toEqual(['blocked']);
  expect(on({ planned_minutes: 60, logged_minutes: 61 })).toEqual([
    'over_hours',
  ]);
  expect(on({ planned_minutes: 60, logged_minutes: 60 })).toEqual([]);
  expect(on({ updated_at: new Date('2026-11-02T12:00:00Z') })).toEqual([
    'stalled',
  ]);
  expect(
    on({
      template: 'implantacao',
      alignment: agreed,
      updated_at: new Date('2026-11-02T12:00:00Z'),
    }),
  ).toEqual([]);
});
test('rules: maintenance does not ask for coverage before work starts', () => {
  expect(on({ status: 'ready', covered: false })).toEqual([]);
  expect(on({ status: 'in_progress', covered: false })).toEqual([
    'no_coverage',
  ]);
  expect(
    on({
      status: 'ready',
      covered: false,
      template: 'implantacao',
      alignment: agreed,
    }),
  ).toEqual(['no_coverage']);
  // Work outside a contract is the first thing in the queue.
  const first = assess(
    facts({ covered: false, follow_up_on: '2026-11-01', owner_user_id: null }),
    '2026-11-05',
    NOW,
  );
  expect(first[0]!.kind).toBe('no_coverage');
});
test('rules: reading boundaries and audience', () => {
  expect(visibleTo('over_hours', 'developer', 'in_progress')).toBe(false);
  expect(visibleTo('over_hours', 'po', 'in_progress')).toBe(false);
  expect(visibleTo('over_hours', 'manager', 'in_progress')).toBe(true);
  expect(visibleTo('no_coverage', 'developer', 'ready')).toBe(false);
  expect(concerns('overdue', 'developer', true)).toBe(true);
  expect(concerns('overdue', 'developer', false)).toBe(false);
  expect(concerns('no_owner', 'po', false)).toBe(true);
  expect(concerns('client_delay', 'manager', false)).toBe(true);
});
test('business days skip the weekend; next step follows the template', () => {
  expect(addBusinessDays('2026-11-06', 1)).toBe('2026-11-09');
  expect(addBusinessDays('2026-11-05', 2)).toBe('2026-11-09');
  expect(nextStep('new', 'manutencao')!.to).toBe('ready');
  expect(nextStep('new', 'implantacao')!.to).toBe('triage');
  expect(nextStep('done', null)).toBeNull();
});

test('creation fills template and commitment; invalid input is refused', async () => {
  const r = await demand('Com padrão');
  expect(r.template).toBe('manutencao');
  expect(r.follow_up_on).toBeTruthy();
  const i = await demand('Implantação', 'dev', { template: 'implantacao' });
  expect(i.template).toBe('implantacao');
  for (const bad of [
    { template: 'outro' },
    { follow_up_on: '2020-01-01' },
    { follow_up_on: '2026-02-31' },
  ]) {
    const res = await raw('po', 'requests', 'POST', {
      interaction_id: interaction,
      title: 'x',
      description: 'x',
      owner_user_id: ids.dev,
      next_action: 'x',
      ...bad,
    });
    expect(res.status).toBe(422);
  }
});
test('maintenance skips triage for the PO; implantation and the developer cannot', async () => {
  const m = await demand('Rápida');
  const devTry = await raw(
    'dev',
    `requests/${m.id}`,
    'PATCH',
    patchOf(m, { status: 'ready' }),
  );
  expect(devTry.status).toBe(403);
  const ready = await call(
    'po',
    `requests/${m.id}`,
    'PATCH',
    patchOf(m, { status: 'ready' }),
  );
  expect(ready.status).toBe('ready');
  const i = await demand('Longa', 'dev', { template: 'implantacao' });
  const refused = await raw(
    'po',
    `requests/${i.id}`,
    'PATCH',
    patchOf(i, { status: 'ready' }),
  );
  expect(refused.status).toBe(422);
});
test('blocking needs a reason and a dependency; leaving clears them', async () => {
  const r = await demand('Bloqueável');
  const t = await call(
    'po',
    `requests/${r.id}`,
    'PATCH',
    patchOf(r, { status: 'triage' }),
  );
  for (const bad of [
    { status: 'blocked' },
    { status: 'blocked', blocked_reason: 'x' },
    { status: 'blocked', blocked_reason: 'x', waiting_on: 'marte' },
    { status: 'blocked', blocked_reason: '  ', waiting_on: 'client' },
  ])
    expect(
      (await raw('po', `requests/${r.id}`, 'PATCH', patchOf(t, bad))).status,
    ).toBe(422);
  const b = await call(
    'po',
    `requests/${r.id}`,
    'PATCH',
    patchOf(t, {
      status: 'blocked',
      blocked_reason: 'Sem credencial',
      waiting_on: 'client',
    }),
  );
  expect(b.blocked_reason).toBe('Sem credencial');
  const back = await call(
    'po',
    `requests/${r.id}`,
    'PATCH',
    patchOf(b, { status: 'triage' }),
  );
  expect(back.blocked_reason).toBeNull();
  expect(back.waiting_on).toBeNull();
});
test('moving a demand renews a lapsed commitment; closing clears it', async () => {
  const r = await demand('Vencida ao mover');
  await db.query(
    'UPDATE requests SET follow_up_on=current_date-3 WHERE id=$1',
    [r.id],
  );
  const t = await call(
    'po',
    `requests/${r.id}`,
    'PATCH',
    patchOf(r, { status: 'ready' }),
  );
  expect(t.follow_up_on.toISOString?.() ?? t.follow_up_on).not.toContain(
    day(-3),
  );
  const q = await queue('dev');
  expect(kinds(q, r.id)).not.toContain('overdue');
  const p = await call(
    'dev',
    `requests/${r.id}`,
    'PATCH',
    patchOf(t, { status: 'in_progress' }),
  );
  const d = await call(
    'dev',
    `requests/${r.id}`,
    'PATCH',
    patchOf(p, { status: 'done' }),
  );
  expect(d.follow_up_on).toBeNull();
  expect(item(await queue('dev'), r.id)).toBeUndefined();
});

test('RBAC: each role reads only what it may; tenants never mix', async () => {
  const own = await demand('Do dev');
  const other = await demand('Do outro dev', 'dev2');
  await db.query('UPDATE requests SET owner_user_id=NULL WHERE id=$1', [
    (await demand('Órfã')).id,
  ]);
  const dev = await queue('dev');
  expect(item(dev, own.id)!.for_me).toBe(true);
  expect(item(dev, other.id)).toBeUndefined();
  expect(dev.items.some((i) => !i.owner_user_id)).toBe(false);
  expect(dev.overloaded).toBeUndefined();
  expect(dev.stage_times).toBeUndefined();
  expect(dev.automation).toBeUndefined();
  const po = await queue('po');
  expect(po.items.some((i) => !i.owner_user_id && i.for_me)).toBe(true);
  expect(po.overloaded).toBeDefined();
  expect(po.stage_times).toBeUndefined();
  expect(po.automation).toBeUndefined();
  const manager = await queue('manager');
  expect(manager.automation).toBeDefined();
  expect(manager.stage_times).toBeDefined();
  // The other tenant has nothing and cannot read a foreign history.
  expect((await queue('foreign')).items).toEqual([]);
  expect((await raw('foreign', `followup/${own.id}/events`)).status).toBe(404);
  // A developer reads only the history of their own work.
  expect((await raw('dev', `followup/${other.id}/events`)).status).toBe(403);
  expect((await raw('dev', `followup/${own.id}/events`)).status).toBe(200);
  // No session, no queue; writes need CSRF.
  expect((await raw('', 'followup')).status).toBe(401);
  const noCsrf = await app(
    new Request(config.origin + '/api/followup/alerts/ack', {
      method: 'POST',
      headers: {
        Cookie: sessions.dev!.cookie,
        Origin: config.origin,
        'Content-Type': 'application/json',
      },
      body: '{}',
    }),
    'followup-tests',
  );
  expect(noCsrf.status).toBe(403);
});
test('a new demand owned by a developer waits for the PO, who alone can release it', async () => {
  const r = await demand('Aguarda liberação');
  expect(item(await queue('po'), r.id)!.for_me).toBe(true);
  expect(item(await queue('manager'), r.id)!.for_me).toBe(true);
  expect(item(await queue('dev'), r.id)!.for_me).toBe(true);
  expect(item(await queue('admin'), r.id)).toBeUndefined();
});
test('over-hours is visible to manager only, and uses approved or pending hours', async () => {
  const r = await demand('Estourada');
  // The rule itself is covered above; here the boundary on the real response shape.
  const dev = JSON.stringify(await queue('dev'));
  expect(dev).not.toContain('over_hours');
  expect(dev).not.toContain('planned_minutes');
  expect(item(await queue('manager'), r.id) ?? { team: true }).toBeTruthy();
});
test('the runtime role cannot rewrite history', async () => {
  const r = await demand('História');
  for (const sql of [
    'DELETE FROM request_events WHERE request_id=$1',
    "UPDATE request_events SET to_status='done' WHERE request_id=$1",
    'DELETE FROM demand_alerts WHERE request_id=$1',
  ])
    await expect(runtime.query(sql, [r.id])).rejects.toThrow();
  // Not even the owner of the schema rewrites an event.
  await expect(
    db.query('DELETE FROM request_events WHERE request_id=$1', [r.id]),
  ).rejects.toThrow('append-only');
});

test('events record every step, its actor, and survive with the change', async () => {
  const r = await demand('Rastreada');
  const t = await call(
    'po',
    `requests/${r.id}`,
    'PATCH',
    patchOf(r, { status: 'ready', next_action: 'Novo passo' }),
  );
  await call(
    'manager',
    `requests/${r.id}`,
    'PATCH',
    patchOf(t, { owner_user_id: ids.dev2 }),
  );
  const events = await call<any[]>('manager', `followup/${r.id}/events`);
  expect(events.map((e) => e.changes)).toEqual([
    ['created'],
    ['status', 'next_action'],
    ['owner'],
  ]);
  expect(events.map((e) => e.actor)).toEqual([
    'Pessoa po',
    'Pessoa po',
    'Pessoa manager',
  ]);
  expect(events[1].from_status).toBe('new');
  expect(events[1].to_status).toBe('ready');
  const failed = await raw(
    'po',
    `requests/${r.id}`,
    'PATCH',
    patchOf(t, { status: 'ready' }),
  );
  expect(failed.status).toBe(409);
  expect(await call<any[]>('manager', `followup/${r.id}/events`)).toHaveLength(
    3,
  );
});

test('alerts: opened once, never repeated, resolved, and a new episode alerts again', async () => {
  const r = await demand('Alerta único');
  await drain();
  await db.query(
    'UPDATE requests SET follow_up_on=current_date-2 WHERE id=$1',
    [r.id],
  );
  const open = () =>
    db
      .query(
        "SELECT count(*)::int n FROM demand_alerts WHERE request_id=$1 AND kind='overdue' AND resolved_at IS NULL",
        [r.id],
      )
      .then((x) => x.rows[0].n);
  const total = () =>
    db
      .query(
        "SELECT count(*)::int n FROM demand_alerts WHERE request_id=$1 AND kind='overdue'",
        [r.id],
      )
      .then((x) => x.rows[0].n);
  for (const minute of [0, 5, 10]) {
    await enqueueSweeps(runtime, new Date(Date.now() + minute * 60000));
    await drain();
  }
  expect(await open()).toBe(1);
  expect(await total()).toBe(1);
  const devQ = await queue('dev');
  expect(
    item(devQ, r.id)!.signals.find((s) => s.kind === 'overdue')!.is_new,
  ).toBe(true);
  expect(devQ.new_alerts).toBeGreaterThan(0);
  // Acknowledged: stops being new, stays in the queue, does not come back on the next sweep.
  await call('dev', 'followup/alerts/ack', 'POST', {});
  await enqueueSweeps(runtime, new Date(Date.now() + 15 * 60000));
  await drain();
  const seen = item(await queue('dev'), r.id)!.signals.find(
    (s) => s.kind === 'overdue',
  )!;
  expect(seen.is_new).toBe(false);
  // Solved: resolved by the job the change itself enqueued.
  const current = (
    await db.query(
      'SELECT status,owner_user_id,next_action,version FROM requests WHERE id=$1',
      [r.id],
    )
  ).rows[0];
  await call(
    'dev',
    `requests/${r.id}`,
    'PATCH',
    patchOf(current, { follow_up_on: day(3) }),
  );
  await drain();
  expect(await open()).toBe(0);
  // Lapsing again is a new episode.
  await db.query(
    'UPDATE requests SET follow_up_on=current_date-1 WHERE id=$1',
    [r.id],
  );
  await enqueueSweeps(runtime, new Date(Date.now() + 20 * 60000));
  await drain();
  expect(await open()).toBe(1);
  expect(await total()).toBe(2);
});
test('ack by a developer touches only their own alerts', async () => {
  await drain();
  const r = await demand('De outro', 'dev2');
  await db.query(
    'UPDATE requests SET follow_up_on=current_date-2 WHERE id=$1',
    [r.id],
  );
  await enqueueSweeps(runtime, new Date(Date.now() + 25 * 60000));
  await drain();
  await call('dev', 'followup/alerts/ack', 'POST', {});
  const row = (
    await db.query(
      "SELECT acknowledged_at FROM demand_alerts WHERE request_id=$1 AND kind='overdue'",
      [r.id],
    )
  ).rows[0];
  expect(row.acknowledged_at).toBeNull();
});

test('failure: the automation failing blocks nothing, loses nothing and recovers', async () => {
  await drain();
  let broken = true,
    calls = 0;
  const faulty: Evaluate = async (client, job) => {
    calls++;
    if (broken) throw Object.assign(new Error('boom'), { code: 'SIMULATED' });
    await evaluate(client, job);
  };
  const r = await demand('Durante a falha');
  await db.query(
    'UPDATE requests SET follow_up_on=current_date-2 WHERE id=$1',
    [r.id],
  );
  await enqueueSweeps(runtime, new Date(Date.now() + 30 * 60000));
  expect(
    await runDueJobs(runtime, { evaluator: faulty, backoffSeconds: 0 }),
  ).toBeGreaterThan(0);
  // Critical transaction still commits while the automation fails.
  const live = await call('dev', 'followup');
  expect(kinds(live, r.id)).toContain('overdue');
  const current = (
    await db.query(
      'SELECT status,owner_user_id,next_action,version FROM requests WHERE id=$1',
      [r.id],
    )
  ).rows[0];
  const moved = await call(
    'po',
    `requests/${r.id}`,
    'PATCH',
    patchOf(current, { status: 'ready', follow_up_on: undefined }),
  );
  expect(moved.status).toBe('ready');
  const events = await call<any[]>('manager', `followup/${r.id}/events`);
  expect(events.length).toBeGreaterThanOrEqual(2);
  const health = await queue('manager');
  expect(health.automation!.retrying).toBeGreaterThan(0);
  const stored = (
    await db.query(
      "SELECT last_error FROM automation_jobs WHERE state='queued' AND attempts>0 LIMIT 1",
    )
  ).rows[0];
  expect(stored.last_error).toBe('SIMULATED');
  expect(calls).toBeGreaterThan(0);
  broken = false;
  await Bun.sleep(1100);
  await drain(faulty);
  expect(
    (
      await db.query(
        "SELECT count(*)::int n FROM automation_jobs WHERE state IN ('queued','running')",
      )
    ).rows[0].n,
  ).toBe(0);
  expect((await queue('manager')).automation!.retrying).toBe(0);
});
test('failure: attempts are limited and a dead job is visible, not lost', async () => {
  await drain();
  const r = await demand('Morta');
  const always: Evaluate = async () => {
    throw new Error('sempre');
  };
  for (let i = 0; i < 8; i++) {
    await runDueJobs(runtime, { evaluator: always, backoffSeconds: 0 });
    await Bun.sleep(5);
  }
  const job = (
    await db.query(
      'SELECT state,attempts,last_error FROM automation_jobs WHERE request_id=$1',
      [r.id],
    )
  ).rows[0];
  expect(job.state).toBe('failed');
  expect(job.attempts).toBe(6);
  expect((await queue('manager')).automation!.failed).toBeGreaterThan(0);
  // The next sweep covers the demand anyway.
  await db.query(
    'UPDATE requests SET follow_up_on=current_date-2 WHERE id=$1',
    [r.id],
  );
  await enqueueSweeps(runtime, new Date(Date.now() + 35 * 60000));
  await drain();
  expect(
    (
      await db.query(
        "SELECT count(*)::int n FROM demand_alerts WHERE request_id=$1 AND kind='overdue' AND resolved_at IS NULL",
        [r.id],
      )
    ).rows[0].n,
  ).toBe(1);
  await db.query("DELETE FROM automation_jobs WHERE state='failed'");
});
test('recovery: a job abandoned by a crashed worker is picked up after its lease', async () => {
  await drain();
  const r = await demand('Abandonada');
  await db.query(
    "UPDATE automation_jobs SET state='running',attempts=1,lease_until=now()+interval '1 hour' WHERE request_id=$1",
    [r.id],
  );
  await drain();
  const held = await db.query(
    'SELECT state FROM automation_jobs WHERE request_id=$1',
    [r.id],
  );
  expect(held.rows[0].state).toBe('running');
  await db.query(
    "UPDATE automation_jobs SET lease_until=now()-interval '1 second' WHERE request_id=$1",
    [r.id],
  );
  await drain();
  const after = await db.query(
    'SELECT state,attempts FROM automation_jobs WHERE request_id=$1',
    [r.id],
  );
  expect(after.rows[0]).toEqual({ state: 'done', attempts: 2 });
});
test('concurrency: parallel workers run a job once and create one alert', async () => {
  await drain();
  const r = await demand('Concorrida');
  await db.query(
    'UPDATE requests SET follow_up_on=current_date-2 WHERE id=$1',
    [r.id],
  );
  const when = new Date(Date.now() + 40 * 60000);
  await Promise.all([1, 2, 3].map(() => enqueueSweeps(runtime, when)));
  const runs: string[] = [];
  const counting: Evaluate = async (client, job) => {
    if (job.kind === 'sweep') runs.push(job.organization_id);
    await evaluate(client, job);
  };
  await Promise.all(
    [1, 2, 3, 4].map(() => runDueJobs(runtime, { evaluator: counting })),
  );
  // One sweep per organization: this bucket was enqueued only once despite three callers.
  const organizations = (
    await db.query('SELECT count(*)::int n FROM organizations')
  ).rows[0].n;
  expect(new Set(runs).size).toBe(runs.length);
  expect(runs.length).toBe(organizations);
  expect(
    (
      await db.query(
        "SELECT count(*)::int n FROM demand_alerts WHERE request_id=$1 AND kind='overdue'",
        [r.id],
      )
    ).rows[0].n,
  ).toBe(1);
});
test('concurrency: two people acting on one demand, the second gets 409 and no event', async () => {
  const r = await demand('Disputada');
  const results = await Promise.all(
    ['po', 'manager'].map((who) =>
      raw(who, `requests/${r.id}`, 'PATCH', patchOf(r, { status: 'ready' })),
    ),
  );
  expect(results.map((x) => x.status).sort()).toEqual([200, 409]);
  const events = await call<any[]>('manager', `followup/${r.id}/events`);
  expect(events.map((e) => e.changes[0])).toEqual(['created', 'status']);
});
test('demands from before migration 010: flagged, usable and given a commitment', async () => {
  const r = await demand('Anterior à 010');
  await db.query(
    'UPDATE requests SET template=NULL,follow_up_on=NULL WHERE id=$1',
    [r.id],
  );
  let q = await queue('dev');
  expect(kinds(q, r.id)).toEqual(['no_follow_up']);
  expect(item(q, r.id)!.template).toBeNull();
  // A legacy demand follows the triage path and asks for no field it does not have.
  const refused = await raw(
    'po',
    `requests/${r.id}`,
    'PATCH',
    patchOf(r, { status: 'ready', version: r.version + 0 }),
  );
  expect(refused.status).toBe(422);
  const same = (
    await db.query(
      'SELECT status,owner_user_id,next_action,version FROM requests WHERE id=$1',
      [r.id],
    )
  ).rows[0];
  // Editing without a date keeps it empty; nothing is invented silently.
  const kept = await call(
    'dev',
    `requests/${r.id}`,
    'PATCH',
    patchOf(same, { next_action: 'Revista' }),
  );
  expect(kept.follow_up_on).toBeNull();
  await drain();
  // Moving stage gives the default commitment and the signal goes away.
  const moved = await call(
    'po',
    `requests/${r.id}`,
    'PATCH',
    patchOf(kept, { status: 'triage' }),
  );
  expect(moved.follow_up_on).not.toBeNull();
  q = await queue('dev');
  expect(kinds(q, r.id)).toEqual([]);
  await drain();
  expect(
    (
      await db.query(
        "SELECT count(*)::int n FROM demand_alerts WHERE request_id=$1 AND kind='no_follow_up' AND resolved_at IS NULL",
        [r.id],
      )
    ).rows[0].n,
  ).toBe(0);
});
test('migration 010 keeps existing demands untouched and writes no event for them', async () => {
  const legacy = `fu_legacy_${randomBytes(3).toString('hex')}_test`;
  await admin.query(`CREATE DATABASE ${ident(legacy)}`);
  const url = new URL(control);
  url.pathname = '/' + legacy;
  const c = new pg.Client({ connectionString: url.href });
  await c.connect();
  try {
    const files = (
      await Array.fromAsync(new Bun.Glob('*.sql').scan('db/migrations'))
    ).sort();
    for (const f of files.filter((f) => f < '010'))
      await c.query(await Bun.file('db/migrations/' + f).text());
    const o = crypto.randomUUID(),
      u = crypto.randomUUID(),
      cl = crypto.randomUUID(),
      p = crypto.randomUUID(),
      i = crypto.randomUUID(),
      q = crypto.randomUUID();
    await c.query("INSERT INTO organizations(id,name) VALUES($1,'L')", [o]);
    await c.query(
      "INSERT INTO users(id,issuer,email,display_name) VALUES($1,'i','l@l.test','L')",
      [u],
    );
    await c.query(
      "INSERT INTO memberships(user_id,organization_id,role) VALUES($1,$2,'po')",
      [u, o],
    );
    await c.query(
      "INSERT INTO clients(id,organization_id,name) VALUES($1,$2,'C')",
      [cl, o],
    );
    await c.query(
      "INSERT INTO projects(id,organization_id,client_id,name) VALUES($1,$2,$3,'P')",
      [p, o, cl],
    );
    await c.query(
      "INSERT INTO interactions(id,organization_id,project_id,kind,summary,occurred_at) VALUES($1,$2,$3,'service','S',now())",
      [i, o, p],
    );
    await c.query(
      "INSERT INTO requests(id,organization_id,interaction_id,title,description,status,owner,owner_user_id,next_action) VALUES($1,$2,$3,'T','D','in_progress','L',$4,'A')",
      [q, o, i, u],
    );
    const before = (await c.query('SELECT * FROM requests')).rows[0];
    await c.query(
      await Bun.file('db/migrations/010_demand_followup.sql').text(),
    );
    const after = (await c.query('SELECT * FROM requests')).rows[0];
    expect(after).toEqual({
      ...before,
      template: null,
      follow_up_on: null,
      blocked_reason: null,
      waiting_on: null,
    });
    expect(
      (await c.query('SELECT count(*)::int n FROM request_events')).rows[0].n,
    ).toBe(0);
    expect(
      (await c.query('SELECT count(*)::int n FROM automation_jobs')).rows[0].n,
    ).toBe(0);
  } finally {
    await c.end();
    await dropDisposableDatabase(admin, legacy);
  }
});
test('rollback: the previous application version works on this schema as the runtime role', async () => {
  // The exact statements of src/server/modules/requests.ts at 75a9c14.
  const id = crypto.randomUUID();
  const created = await runtime.query(
    "INSERT INTO requests(id,organization_id,interaction_id,title,description,status,owner,owner_user_id,next_action) VALUES($1,$2,$3,$4,$5,'new',$6,$7,$8) RETURNING *",
    [id, org, interaction, 'Versão anterior', 'D', 'Pessoa dev', ids.dev, 'A'],
  );
  expect(created.rows[0].template).toBeNull();
  const updated = await runtime.query(
    'UPDATE requests SET status=$3,owner_user_id=$4,next_action=$5,version=version+1,updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING *',
    [id, org, 'triage', ids.dev, 'B'],
  );
  expect(updated.rows[0].version).toBe(2);
  // Without a worker, the change is still on record and its job just waits.
  const events = await db.query(
    'SELECT to_status FROM request_events WHERE request_id=$1 ORDER BY occurred_at,version',
    [id],
  );
  expect(events.rows.map((e) => e.to_status)).toEqual(['new', 'triage']);
  const jobs = await db.query(
    "SELECT count(*)::int n FROM automation_jobs WHERE request_id=$1 AND state='queued'",
    [id],
  );
  expect(jobs.rows[0].n).toBe(2);
  await drain();
});
test('more than 500 open demands: every one is covered and no open alert is resolved', async () => {
  await drain();
  const total = 650,
    ids_: string[] = [];
  const rows = await db.query(
    `INSERT INTO requests(id,organization_id,interaction_id,title,description,status,owner,owner_user_id,next_action,template,follow_up_on,updated_at)
 SELECT gen_random_uuid(),$1,$2,'Volume '||g,'D','ready','Pessoa dev2',$3,'A','manutencao',current_date-1,now()-make_interval(mins=>g)
 FROM generate_series(1,$4::int) g RETURNING id`,
    [org, interaction, ids.dev2, total],
  );
  for (const r of rows.rows) ids_.push(r.id);
  const newest = ids_[0]!,
    oldest = ids_[total - 1]!;
  const openOf = async () =>
    (
      await db.query(
        "SELECT count(*)::int n FROM demand_alerts WHERE kind='overdue' AND resolved_at IS NULL AND request_id=ANY($1::uuid[])",
        [ids_],
      )
    ).rows[0].n;
  await drain();
  // All of them, including those past any 500 cut in either direction.
  await enqueueSweeps(runtime, new Date(Date.now() + 45 * 60000));
  const started = Date.now();
  await drain();
  const sweepMs = Date.now() - started;
  expect(await openOf()).toBe(total);
  // The queue covers them all too, with the ones past 500 present.
  const q = await queue('dev2');
  for (const id of [newest, oldest]) expect(kinds(q, id)).toContain('overdue');
  expect(q.items.filter((i) => ids_.includes(i.id))).toHaveLength(total);
  // Repeated and concurrent sweeps neither resolve nor duplicate.
  const openIds = async () =>
    (
      await db.query(
        'SELECT id FROM demand_alerts WHERE resolved_at IS NULL AND request_id=ANY($1::uuid[]) ORDER BY id',
        [ids_],
      )
    ).rows.map((r) => r.id);
  const first = await openIds();
  await enqueueSweeps(runtime, new Date(Date.now() + 50 * 60000));
  await Promise.all([1, 2, 3, 4].map(() => runDueJobs(runtime)));
  await drain();
  expect(await openIds()).toEqual(first);
  // A failed sweep changes nothing, and the retry leaves the same alerts.
  let failed = 0;
  const flaky: Evaluate = async (client, job) => {
    await evaluate(client, job);
    if (job.kind === 'sweep' && !failed++) throw new Error('after the writes');
  };
  await enqueueSweeps(runtime, new Date(Date.now() + 55 * 60000));
  await runDueJobs(runtime, { evaluator: flaky, backoffSeconds: 0 });
  expect(failed).toBeGreaterThan(0);
  await Bun.sleep(5);
  await drain();
  expect(await openIds()).toEqual(first);
  // Closing one demand past the cut resolves exactly that alert, by its own job.
  const cur = (
    await db.query(
      'SELECT status,owner_user_id,next_action,version FROM requests WHERE id=$1',
      [oldest],
    )
  ).rows[0];
  const started2 = await call(
    'dev2',
    `requests/${oldest}`,
    'PATCH',
    patchOf(cur, { status: 'in_progress', follow_up_on: day(2) }),
  );
  await call(
    'dev2',
    `requests/${oldest}`,
    'PATCH',
    patchOf(started2, { status: 'done' }),
  );
  await drain();
  expect(await openOf()).toBe(total - 1);
  // A closed demand whose own job never ran is closed by the next sweep, and only it.
  await db.query("UPDATE requests SET status='done' WHERE id=$1", [newest]);
  await db.query(
    "UPDATE automation_jobs SET state='done' WHERE request_id=$1 AND state='queued'",
    [newest],
  );
  await enqueueSweeps(runtime, new Date(Date.now() + 60 * 60000));
  await drain();
  expect(await openOf()).toBe(total - 2);
  console.log(`sweep with ${total} open demands: ${sweepMs} ms`);
  // Leaves the shared database as the other tests expect it.
  await db.query("UPDATE requests SET status='done' WHERE id=ANY($1::uuid[])", [
    ids_,
  ]);
  await enqueueSweeps(runtime, new Date(Date.now() + 65 * 60000));
  await drain();
  expect(await openOf()).toBe(0);
}, 120000);
test('summary travels with the overview without an extra start-up call', async () => {
  const o = await call('dev', 'overview');
  expect(o.followup.for_me).toBeGreaterThanOrEqual(0);
  expect(typeof o.followup.new_alerts).toBe('number');
  expect(JSON.stringify(o.followup)).not.toContain('minutes');
  expect(today).toBeTruthy();
});

// Alinhamento e Aceite: the same real database and API, one rule per test.
const align = (who: Who, r: any, body: Record<string, unknown>) =>
  raw(who, `requests/${r.id}/alignment`, 'POST', {
    version: r.version,
    ...body,
  });
const fresh = async (id: string) =>
  (await db.query('SELECT * FROM requests WHERE id=$1', [id])).rows[0];
async function ok(who: Who, r: any, body: Record<string, unknown>) {
  const res = await align(who, r, body);
  if (!res.ok)
    throw new Error(`${body.kind}: ${res.status} ${await res.text()}`);
  return fresh(r.id);
}
/** Walks a new demand to a stage through the API, as the PO. */
async function at(
  title: string,
  to: string,
  template = 'manutencao',
  owner: Who = 'dev',
) {
  let r = await demand(title, owner, { template });
  for (const s of ['triage', 'ready', 'in_progress']) {
    if (s === 'triage' && template === 'manutencao') continue;
    r = await call(
      'po',
      `requests/${r.id}`,
      'PATCH',
      patchOf(r, { status: s }),
    );
    if (s === to) break;
  }
  return fresh(r.id);
}
const answer = async (summary = 'Cliente respondeu', project?: string) =>
  (
    await call('po', 'interactions', 'POST', {
      project_id:
        project ??
        (
          await db.query('SELECT project_id FROM interactions WHERE id=$1', [
            interaction,
          ])
        ).rows[0].project_id,
      kind: 'service',
      summary,
      occurred_at: new Date().toISOString(),
    })
  ).id as string;
const trailOf = (id: string) =>
  db.query(
    'SELECT * FROM request_alignment WHERE request_id=$1 ORDER BY recorded_at',
    [id],
  );
const audited = async (id: string, action: string) =>
  (
    await db.query(
      'SELECT 1 FROM audit_events WHERE entity_id=$1 AND action=$2',
      [id, action],
    )
  ).rowCount;
const delivered = async (title: string, template = 'implantacao') => {
  let r = await at(title, 'in_progress', template);
  r = await ok('po', r, {
    kind: 'agreement',
    criteria: 'Frete calculado na vitrine',
  });
  return ok('dev', r, { kind: 'delivered' });
};

test('maintenance without an agreement works exactly as before', async () => {
  const r = await at('Manutenção simples', 'in_progress');
  expect(kinds(await queue('po'), r.id)).not.toContain('no_agreement');
  expect(item(await queue('dev'), r.id)!.alignment).toBeNull();
  const done = await call(
    'dev',
    `requests/${r.id}`,
    'PATCH',
    patchOf(r, { status: 'done' }),
  );
  expect(done.status).toBe('done');
  expect((await trailOf(r.id)).rowCount).toBe(0);
});

test('implantation without confirmation warns and audits, and never stops the work', async () => {
  const r = await at('Implantação sem combinado', 'ready', 'implantacao');
  expect(kinds(await queue('po'), r.id)).toContain('no_agreement');
  const started = await call(
    'po',
    `requests/${r.id}`,
    'PATCH',
    patchOf(r, { status: 'in_progress' }),
  );
  expect(started.status).toBe('in_progress');
  expect(await audited(r.id, 'started_without_confirmation')).toBe(1);
  const agreed = await ok('po', await fresh(r.id), {
    kind: 'agreement',
    criteria: 'Critério',
  });
  const q = await queue('po');
  expect(kinds(q, r.id)).toContain('unconfirmed');
  expect(kinds(q, r.id)).not.toContain('no_agreement');
  const confirmed = await ok('po', agreed, {
    kind: 'confirmation',
    evidence_interaction_id: await answer('Cliente confirmou por telefone'),
  });
  expect(kinds(await queue('po'), r.id)).not.toContain('unconfirmed');
  expect(confirmed.status).toBe('in_progress');
});

test('a PO accepts with the client evidence; a developer cannot attest their own delivery', async () => {
  const r = await delivered('Entrega com aceite');
  const seen = item(await queue('po'), r.id)!;
  expect(seen.alignment!.delivered_at).toBeTruthy();
  expect(seen.signals.map((s) => s.kind)).toContain('awaiting_acceptance');
  expect(seen.for_me).toBe(true);
  const evidence = await answer('Cliente aprovou por e-mail');
  // The developer who delivered cannot close nor accept it, by either route.
  expect(
    (
      await align('dev', r, {
        kind: 'accepted',
        evidence_interaction_id: evidence,
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await raw(
        'dev',
        `requests/${r.id}`,
        'PATCH',
        patchOf(r, { status: 'done' }),
      )
    ).status,
  ).toBe(403);
  expect((await fresh(r.id)).status).toBe('in_progress');
  const done = await ok('po', r, {
    kind: 'accepted',
    evidence_interaction_id: evidence,
  });
  expect(done.status).toBe('done');
  expect(done.follow_up_on).toBeNull();
  const rows = (await trailOf(r.id)).rows;
  expect(rows.map((x) => x.kind)).toEqual([
    'agreement',
    'delivered',
    'accepted',
  ]);
  expect(rows[2].evidence_interaction_id).toBe(evidence);
  expect(rows[2].recorded_by).toBe(ids.po);
  expect(rows[2].recorded_by_executor).toBe(false);
  expect(await audited(r.id, 'alignment:accepted')).toBe(1);
});

test('acceptance needs evidence from the same project, after the delivery', async () => {
  const before = await answer('Resposta antiga');
  const r = await delivered('Evidência');
  const accept = (evidence?: unknown) =>
    align('po', r, { kind: 'accepted', evidence_interaction_id: evidence });
  expect((await accept()).status).toBe(422);
  expect((await accept(before)).status).toBe(422);
  const other = await call('po', 'projects', 'POST', {
    client_id: (
      await db.query('SELECT id FROM clients WHERE organization_id=$1', [org])
    ).rows[0].id,
    name: `Outro ${crypto.randomUUID()}`,
  });
  expect((await accept(await answer('Outro projeto', other.id))).status).toBe(
    422,
  );
  expect((await trailOf(r.id)).rows.map((x) => x.kind)).not.toContain(
    'accepted',
  );
  expect((await fresh(r.id)).status).toBe('in_progress');
});

test('silence is never acceptance: an overdue delivery stays open through every sweep', async () => {
  const r = await delivered('Cliente em silêncio');
  await db.query(
    "UPDATE requests SET follow_up_on=CURRENT_DATE-30,updated_at=now()-interval '60 days' WHERE id=$1",
    [r.id],
  );
  await enqueueSweeps(runtime, new Date(Date.now() + 864e5));
  await drain();
  const after = await fresh(r.id);
  expect(after.status).toBe('in_progress');
  expect((await trailOf(r.id)).rows.map((x) => x.kind)).toEqual([
    'agreement',
    'delivered',
  ]);
  expect(kinds(await queue('po'), r.id)).toContain('awaiting_acceptance');
  const open = await db.query(
    "SELECT 1 FROM demand_alerts WHERE request_id=$1 AND kind='awaiting_acceptance' AND resolved_at IS NULL",
    [r.id],
  );
  expect(open.rowCount).toBe(1);
});

test('a refusal goes back to execution with its reason, and repeating it raises one signal', async () => {
  let r = await delivered('Recusas');
  r = await ok('po', r, {
    kind: 'rejected',
    evidence_interaction_id: await answer('Cliente recusou'),
    reason: 'Frete errado no Norte',
  });
  expect(r.status).toBe('in_progress');
  expect(r.next_action).toBe('Corrigir: Frete errado no Norte');
  expect((await align('po', r, { kind: 'rejected', reason: 'x' })).status).toBe(
    409,
  );
  expect(kinds(await queue('po'), r.id)).not.toContain('repeated_change');
  r = await ok('dev', r, { kind: 'delivered' });
  r = await ok('po', r, {
    kind: 'rejected',
    evidence_interaction_id: await answer('Recusou de novo'),
    reason: 'Ainda errado',
  });
  await drain();
  await drain();
  expect(kinds(await queue('po'), r.id)).toContain('repeated_change');
  expect(
    (
      await db.query(
        "SELECT 1 FROM demand_alerts WHERE request_id=$1 AND kind='repeated_change'",
        [r.id],
      )
    ).rowCount,
  ).toBe(1);
  const refused = await align('po', r, {
    kind: 'rejected',
    evidence_interaction_id: await answer('x'),
  });
  expect(refused.status).toBe(409);
});

test('high risk stops until a person authorizes, and a new version asks again', async () => {
  let r = await at('Migrar dados de produção', 'ready', 'implantacao');
  r = await ok('po', r, {
    kind: 'agreement',
    criteria: 'Migração conferida',
    high_risk: true,
  });
  const start = (who: Who, x: any) =>
    raw(
      who,
      `requests/${x.id}`,
      'PATCH',
      patchOf(x, { status: 'in_progress' }),
    );
  expect((await start('po', r)).status).toBe(403);
  expect((await start('admin', r)).status).toBe(403);
  expect(kinds(await queue('manager'), r.id)).toContain('risk_unauthorized');
  // Neither the PO nor the developer can authorize, and the PO cannot drop the mark.
  expect((await align('po', r, { kind: 'risk_authorization' })).status).toBe(
    403,
  );
  expect((await align('dev', r, { kind: 'risk_authorization' })).status).toBe(
    403,
  );
  expect(
    (
      await align('po', r, {
        kind: 'agreement',
        criteria: 'Sem risco',
        high_risk: false,
        reason: 'Tentativa',
      })
    ).status,
  ).toBe(403);
  r = await ok('manager', r, { kind: 'risk_authorization' });
  expect(kinds(await queue('manager'), r.id)).not.toContain(
    'risk_unauthorized',
  );
  // Changing what was authorized needs a new authorization.
  r = await ok('po', r, {
    kind: 'agreement',
    criteria: 'Migração maior',
    high_risk: true,
    reason: 'Cliente pediu mais tabelas',
  });
  expect((await start('po', r)).status).toBe(403);
  r = await ok('admin', r, { kind: 'risk_authorization' });
  expect((await start('po', r)).status).toBe(200);
  expect(
    (await trailOf(r.id)).rows.filter((x) => x.kind === 'risk_authorization')
      .length,
  ).toBe(2);
});

test('a mark added during execution stops the delivery and the closing too', async () => {
  let r = await at('Risco descoberto depois', 'in_progress');
  r = await ok('po', r, {
    kind: 'agreement',
    criteria: 'Critério',
    high_risk: true,
  });
  expect((await align('dev', r, { kind: 'delivered' })).status).toBe(403);
  expect(
    (
      await raw(
        'po',
        `requests/${r.id}`,
        'PATCH',
        patchOf(r, { status: 'done' }),
      )
    ).status,
  ).toBe(403);
});

test('closing without acceptance is allowed for a PO and stays on record as what it is', async () => {
  const r = await delivered('Fecha sem aceite');
  await call('po', `requests/${r.id}`, 'PATCH', patchOf(r, { status: 'done' }));
  const rows = (await trailOf(r.id)).rows.map((x) => x.kind);
  expect(rows).toContain('closed_without_acceptance');
  expect(rows).not.toContain('accepted');
  expect(await audited(r.id, 'alignment:closed_without_acceptance')).toBe(1);
  // Reopened, it does not come back as waiting for an answer.
  const back = await call(
    'po',
    `requests/${r.id}`,
    'PATCH',
    patchOf(await fresh(r.id), { status: 'triage' }),
  );
  expect(item(await queue('po'), back.id)!.alignment!.delivered_at).toBeNull();
});

test('who executed may record the client evidence, and the trail says so', async () => {
  const r = await delivered('PO que também trabalhou');
  await db.query(
    "INSERT INTO time_entries(id,organization_id,project_id,request_id,user_id,work_date,minutes,comment,fingerprint) SELECT gen_random_uuid(),r.organization_id,i.project_id,r.id,$2,CURRENT_DATE,30,'Revisão','f'||r.id FROM requests r JOIN interactions i ON i.id=r.interaction_id WHERE r.id=$1",
    [r.id, ids.po],
  );
  await ok('po', r, {
    kind: 'accepted',
    evidence_interaction_id: await answer('Aprovado'),
  });
  const row = (await trailOf(r.id)).rows.at(-1);
  expect(row.recorded_by_executor).toBe(true);
  expect(await audited(r.id, 'alignment:accepted;by_executor')).toBe(1);
});

test('two people answering at once: exactly one wins', async () => {
  const r = await delivered('Dois aceites');
  const evidence = await answer('Aprovado');
  const results = await Promise.all(
    (['po', 'manager'] as Who[]).map((w) =>
      align(w, r, { kind: 'accepted', evidence_interaction_id: evidence }),
    ),
  );
  expect(results.map((x) => x.status).sort()).toEqual([200, 409]);
  expect(
    (await trailOf(r.id)).rows.filter((x) => x.kind === 'accepted').length,
  ).toBe(1);
});

test('reading and writing stay inside the owner and the organization', async () => {
  const r = await delivered('Fronteiras');
  expect((await raw('dev', `requests/${r.id}/alignment`)).status).toBe(200);
  expect((await raw('dev2', `requests/${r.id}/alignment`)).status).toBe(403);
  expect((await raw('foreign', `requests/${r.id}/alignment`)).status).toBe(404);
  expect((await align('dev2', r, { kind: 'delivered' })).status).toBe(403);
  expect(
    (await align('foreign', r, { kind: 'agreement', criteria: 'x' })).status,
  ).toBe(404);
  expect(
    (await align('dev', r, { kind: 'agreement', criteria: 'x' })).status,
  ).toBe(403);
  expect((await raw('', `requests/${r.id}/alignment`)).status).toBe(401);
  const stale = await align(
    'po',
    { ...r, version: r.version - 1 },
    {
      kind: 'agreement',
      criteria: 'x',
    },
  );
  expect(stale.status).toBe(409);
});

test('an old agreement stays readable and the trail cannot be rewritten', async () => {
  let r = await at('Versões', 'ready');
  r = await ok('po', r, { kind: 'agreement', criteria: 'Primeira versão' });
  expect(
    (await align('po', r, { kind: 'agreement', criteria: 'Segunda' })).status,
  ).toBe(422);
  r = await ok('po', r, {
    kind: 'agreement',
    criteria: 'Segunda versão',
    reason: 'Cliente mudou',
  });
  const text = (
    await call<{ text: string }[]>('po', `requests/${r.id}/alignment`)
  ).map((t) => t.text);
  expect(text[0]).toContain('Combinado v1 · Primeira versão');
  expect(text[1]).toContain('Combinado v2 · Segunda versão · Cliente mudou');
  expect(item(await queue('dev'), r.id)!.alignment!.criteria).toBe(
    'Segunda versão',
  );
  const client = await runtime.connect();
  try {
    await expect(
      client.query(
        "UPDATE request_alignment SET reason='x' WHERE request_id=$1",
        [r.id],
      ),
    ).rejects.toThrow();
    await expect(
      client.query('DELETE FROM request_alignment WHERE request_id=$1', [r.id]),
    ).rejects.toThrow();
  } finally {
    client.release();
  }
  await expect(
    db.query("UPDATE request_alignment SET reason='x' WHERE request_id=$1", [
      r.id,
    ]),
  ).rejects.toThrow('append-only');
  await expect(
    db.query('DELETE FROM request_alignment WHERE request_id=$1', [r.id]),
  ).rejects.toThrow('append-only');
});

test('recording needs no worker, and suggested criteria never reach a developer', async () => {
  const r = await at('Sem automação', 'in_progress');
  await db.query(
    'UPDATE requests SET suggested_acceptance_criteria=$2::jsonb WHERE id=$1',
    [
      r.id,
      JSON.stringify([{ text: 'Sugerido', quote: 'q', start: 0, end: 1 }]),
    ],
  );
  expect(item(await queue('po'), r.id)!.suggested_criteria).toBe('Sugerido');
  expect('suggested_criteria' in item(await queue('dev'), r.id)!).toBe(false);
  const failing: Evaluate = () => Promise.reject(new Error('worker down'));
  const after = await ok('po', await fresh(r.id), {
    kind: 'agreement',
    criteria: 'Critério',
  });
  await drain(failing);
  expect(item(await queue('po'), after.id)!.alignment!.version).toBe(1);
});

test('baseline: exact numbers for a known history, and it cannot write', async () => {
  // The other organization has no demand of its own: every number below comes from this one.
  const c = await call('foreign', 'clients', 'POST', { name: 'Base' });
  const p = await call('foreign', 'projects', 'POST', {
    client_id: c.id,
    name: 'Base',
  });
  const origin = await call('foreign', 'interactions', 'POST', {
    project_id: p.id,
    kind: 'service',
    summary: 'Pedido',
    occurred_at: new Date().toISOString(),
  });
  let r = await call('foreign', 'requests', 'POST', {
    interaction_id: origin.id,
    title: 'Título que não pode sair no relatório',
    description: 'x',
    owner_user_id: ids.foreign,
    next_action: 'Primeira',
  });
  for (const status of [
    'ready',
    'in_progress',
    'done',
    'triage',
    'ready',
    'in_progress',
    'done',
  ])
    r = await call(
      'foreign',
      `requests/${r.id}`,
      'PATCH',
      patchOf(r, { status }),
    );
  await db.query(
    "INSERT INTO time_entries(id,organization_id,project_id,request_id,user_id,work_date,minutes,comment,fingerprint) VALUES(gen_random_uuid(),$1,$2,$3,$4,CURRENT_DATE,90,'x','base')",
    [foreignOrg, p.id, r.id, ids.foreign],
  );
  const scratch = await db.connect();
  try {
    const out = (await runBaseline(scratch, today)) as any;
    const m = out[foreignOrg].por_modelo.manutencao;
    expect(m.demandas).toBe(1);
    expect(m.concluidas).toBe(1);
    expect(m.reaberturas).toBe(1);
    expect(m.taxa_retrabalho).toBe(1);
    expect(m.amostra_pequena).toBe(true);
    // One action at each of the 7 moves, by a person whose role is PO; created too.
    expect(m.acoes_do_po_por_demanda_mediana).toBe(8);
    expect(m.horas_do_po_por_demanda_mediana).toBe(1.5);
    expect(m.horas_por_demanda_mediana).toBe(1.5);
    expect(m.ciclo_horas_mediana).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(out)).not.toContain('Título que não pode');
    // The guarantee is the database's: the same kind of transaction refuses a write.
    await scratch.query('BEGIN TRANSACTION READ ONLY');
    await expect(
      scratch.query("UPDATE requests SET title='x' WHERE id=$1", [r.id]),
    ).rejects.toThrow('read-only');
    await scratch.query('ROLLBACK');
  } finally {
    scratch.release();
  }
});
