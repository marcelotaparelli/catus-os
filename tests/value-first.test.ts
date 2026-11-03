import { afterAll, beforeAll, expect, test } from 'bun:test';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/server/app';
import { oidcProvider } from '../src/server/auth/oidc';
import { assessHealth, humanMissing } from '../src/server/economics/insights';
import { calculate } from '../src/server/economics/engine';
import {
  hoursLabel,
  moneyGrouped,
  percentLabel,
} from '../src/shared/economics';
import type { EconomicsInput } from '../src/shared/economics';
import type {
  FinancialOverview,
  OperationalOverview,
  PersonalOverview,
} from '../src/shared/overview';
import { provisionRoles } from '../scripts/lib/provision-roles';
import { ident } from '../scripts/lib/privileges';
import { dropDisposableDatabase } from './support/disposable';
import { codeFor, config, mockOidcFetch } from './support/oidc-provider';
import {
  buildEcommerceScenario,
  EXPECTED,
  NAMES,
} from './support/ecommerce-scenario';
import type { Actor } from './support/ecommerce-scenario';

const name = `vf_${randomBytes(4).toString('hex')}_test`;
const control = new URL(process.env.DATABASE_URL!);
control.pathname = '/postgres';
const target = new URL(control);
target.pathname = '/' + name;
const admin = new pg.Pool({ connectionString: control.href });
let db: pg.Pool, runtime: pg.Pool;
let app: ReturnType<typeof createApp>;
const org = crypto.randomUUID(),
  foreignOrg = crypto.randomUUID();
const ids: Record<Actor | 'foreign', string> = {
  admin: crypto.randomUUID(),
  manager: crypto.randomUUID(),
  po: crypto.randomUUID(),
  dev: crypto.randomUUID(),
  dev2: crypto.randomUUID(),
  foreign: crypto.randomUUID(),
};
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
    'value-first-tests',
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
    'value-first-tests',
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
      'value-first-tests',
    )
  ).json();
  return { cookie, csrf: session.csrfToken as string };
}
type Scenario = Awaited<ReturnType<typeof buildEcommerceScenario>>;
let scenario: Scenario;
const financial = (who = 'manager') => call<FinancialOverview>(who, 'overview');
const projectOf = (o: FinancialOverview, key: keyof typeof NAMES) =>
  o.projects.find((p) => p.project_name === NAMES[key])!;
const counts = async () =>
  (
    await db.query(
      "SELECT (SELECT count(*) FROM economic_reports)::int reports,(SELECT count(*) FROM economic_events)::int events,(SELECT count(*) FROM audit_events WHERE entity_type<>'session')::int audit,(SELECT count(*) FROM time_events)::int decisions",
    )
  ).rows[0];

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${ident(name)}`);
  const roles = await provisionRoles(
    target.href,
    `.local/value-first-${name}.env`,
  );
  const p = Bun.spawn(['node_modules/.bin/bun', 'scripts/migrate.ts'], {
    env: { ...process.env, ...roles },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  if ((await p.exited) !== 0) throw new Error('Migration failed');
  db = new pg.Pool({ connectionString: target.href });
  runtime = new pg.Pool({ connectionString: roles.RUNTIME_DATABASE_URL });
  await db.query('INSERT INTO organizations(id,name) VALUES($1,$2),($3,$4)', [
    org,
    'Agência sintética',
    foreignOrg,
    'Outra agência',
  ]);
  for (const [key, display, role, o] of [
    ['admin', 'Alice Admin', 'administrator', org],
    ['manager', 'Marina Gestora', 'manager', org],
    ['po', 'Paulo PO', 'po', org],
    ['dev', 'Davi Dev', 'developer', org],
    ['dev2', 'Bia Dev', 'developer', org],
    ['foreign', 'Fora', 'manager', foreignOrg],
  ] as const) {
    await db.query(
      'INSERT INTO users(id,issuer,email,display_name) VALUES($1,$2,$3,$4)',
      [ids[key], config.oidc!.issuer, `${key}@catus.test`, display],
    );
    await db.query(
      'INSERT INTO memberships(user_id,organization_id,role) VALUES($1,$2,$3)',
      [ids[key], o, role],
    );
  }
  app = createApp(config, oidcProvider(config, await mockOidcFetch()), {
    pool: runtime,
    extractionProvider: null,
    loginRate: { limit: 1000, windowSeconds: 60 },
    apiRate: { limit: 5000, windowSeconds: 60 },
  });
  for (const k of Object.keys(ids))
    sessions[k] = await login(`${k}@catus.test`);
  scenario = await buildEcommerceScenario(call as never, ids);
}, 120000);
afterAll(async () => {
  await Promise.all([db?.end(), runtime?.end()]);
  await dropDisposableDatabase(admin, name);
  for (const r of ['runtime', 'migrator', 'maintenance', 'aiworker'])
    await admin.query(`DROP ROLE IF EXISTS ${ident(name + '_' + r)}`);
  await admin.end();
});

test('complete journey yields the hand-worked values, identical to persisted M4 reports', async () => {
  const before = await financial();
  for (const key of ['a', 'b', 'c'] as const) {
    const p = projectOf(before, key);
    expect(p.result).toMatchObject(EXPECTED[key] as never);
    const report = await call('manager', 'economics/reports', 'POST', {
      terms_id: scenario.terms[key],
      as_of: p.result!.as_of,
    });
    expect(report.result).toEqual(p.result);
  }
  expect(projectOf(before, 'a').health).toBe('at_risk');
  expect(projectOf(before, 'b').health).toBe('negative');
  expect(projectOf(before, 'c').health).toBe('positive');
  const after = await financial();
  const a = projectOf(after, 'a').source!.latest_report!;
  expect(a.matches_live).toBe(true);
  expect(a.input_hash).toMatch(/^[0-9a-f]{64}$/);
});
test('five executive questions are answered from real records', async () => {
  const o = await financial();
  expect(o.projects.map((p) => p.health)).toEqual([
    'negative',
    'at_risk',
    'incomplete',
    'unmeasured',
    'positive',
  ]);
  const a = projectOf(o, 'a');
  // Where hours go: by demand, summing exactly to the engine's project totals.
  expect(a.hours[0]).toMatchObject({
    title: 'Checkout com Pix',
    owner: 'Davi Dev',
    planned_minutes: 1800,
    approved_minutes: 1500,
    remaining_minutes: 1200,
    variance_minutes: 900,
  });
  for (const k of [
    'planned_minutes',
    'approved_minutes',
    'remaining_minutes',
  ] as const)
    expect(a.hours.reduce((n, h) => n + h[k]!, 0)).toBe(a.result![k]!);
  const overrun = a.actions.find((x) => x.code === 'hours_overrun')!;
  expect(overrun.owner).toBe('Davi Dev');
  expect(overrun.reason).toContain('BRL 1.890,00');
  expect(a.actions.find((x) => x.code === 'overdue')?.owner).toBe('Bia Dev');
  const b = projectOf(o, 'b').actions[0]!;
  expect(b.code).toBe('margin_negative');
  expect(b.owner).toBe('Alice Admin ou Marina Gestora');
  expect(b.reason).toContain('BRL -360,00');
  expect(b.reason).toContain('-6,00%');
  expect(projectOf(o, 'c').actions).toEqual([]);
  expect(projectOf(o, 'e').actions[0]).toMatchObject({
    code: 'commercial_gap',
    action: 'Decidir o escopo submetido',
  });
  // Every action names a person and has a destination.
  for (const p of o.projects)
    for (const x of p.actions) {
      expect(x.owner.length).toBeGreaterThan(0);
      expect(x.reason.length).toBeGreaterThan(0);
      expect(x.target.route).toBeTruthy();
    }
});
test('missing data stays unavailable, then appears only after independent decisions', async () => {
  let d = projectOf(await financial(), 'd');
  expect(d.health).toBe('incomplete');
  expect(d.result).toMatchObject(EXPECTED.dIncomplete as never);
  expect(d.projection_missing.map((m) => m.label)).toContain(
    'Capacidade alocada declarada',
  );
  expect(d.actions[0]!.code).toBe('hours_pending');
  expect(d.actions[0]!.owner).toBe('Alice Admin ou Marina Gestora');
  expect(d.blocked_requests).toBe(1);
  expect(d.uncovered_requests).toBe(1);
  // The person who logged the hours cannot decide them; the preparer cannot approve.
  const pending = (await call('manager', 'economics')).times.find(
    (t: { project_id: string; state: string }) =>
      t.project_id === scenario.projects.d && t.state === 'pending',
  );
  expect(
    (
      await raw('dev', `economics/times/${pending.id}/action`, 'POST', {
        expected_state: 'pending',
        action: 'approved',
        reason: 'Autoaprovação',
        cost_role: null,
      })
    ).status,
  ).toBe(403);
  await call('manager', `economics/times/${pending.id}/action`, 'POST', {
    expected_state: 'pending',
    action: 'approved',
    reason: 'Conferido',
    cost_role: null,
  });
  const capacity = await call('manager', 'economics/records', 'POST', {
    kind: 'capacity',
    project_id: scenario.projects.d,
    currency: 'BRL',
    valid_from: scenario.period.from,
    valid_until: scenario.period.until,
    source: 'SINTÉTICO capacidade',
    payload: { user_id: ids.dev, available_minutes: 840 },
    previous_id: null,
  });
  expect(
    (
      await raw('manager', `economics/records/${capacity.id}/decide`, 'POST', {
        revision: 1,
        decision: 'approved',
        reason: 'Autoaprovação',
        cost_role: null,
      })
    ).status,
  ).toBe(403);
  d = projectOf(await financial(), 'd');
  expect(d.result!.projected_margin).toBeNull();
  expect(d.actions[0]!.code).toBe('record_pending');
  expect(d.actions[0]!.owner).toBe('Alice Admin');
  await call('admin', `economics/records/${capacity.id}/decide`, 'POST', {
    revision: 1,
    decision: 'approved',
    reason: 'Conferido',
    cost_role: null,
  });
  d = projectOf(await financial(), 'd');
  expect(d.result).toMatchObject(EXPECTED.dComplete as never);
  // Margin is known now, but blocked and uncovered work keep it at risk.
  expect(d.health).toBe('at_risk');
});
test('reading the overview writes nothing', async () => {
  const before = await counts();
  for (const who of ['manager', 'admin', 'po', 'dev'])
    await call(who, 'overview');
  expect(await counts()).toEqual(before);
});
test('roles keep their existing boundaries: money only for manager and administrator', async () => {
  const money =
    /amount_minor|_minor|minor_per_hour|cost_incurred|eac|margin|revenue|budget_cost|cost_variance|BRL|"result"|"estimate_to_complete"/;
  const po = await call<OperationalOverview>('po', 'overview');
  expect(po.kind).toBe('operational');
  expect(JSON.stringify(po)).not.toMatch(money);
  const dev = await call<PersonalOverview>('dev', 'overview');
  expect(dev.kind).toBe('personal');
  expect(JSON.stringify(dev)).not.toMatch(money);
  expect(JSON.stringify(dev)).not.toMatch(/planned_minutes|remaining_minutes/);
  // Developer sees only their own minutes, never a colleague's.
  expect(Object.keys(dev.logged_by_request).sort()).toEqual(
    [
      scenario.requests.aPix,
      scenario.requests.cErp,
      scenario.requests.dCartao,
    ].sort(),
  );
  expect(dev.hours.approved).toBe(1500 + 1200 + 360);
  expect(
    po.demands.find((d) => d.title === 'Cupons de desconto'),
  ).toMatchObject({
    overdue: true,
    remaining_minutes: 240,
    covered: true,
  });
  expect(po.demands[0]!.status).toBe('blocked');
  expect(po.scopes.map((s) => s.state)).toEqual(['submitted']);
  expect(po.actions.map((a) => a.code)).toContain('uncovered');
  const admin = await financial('admin');
  expect(admin.governance!.members_by_role).toEqual({
    administrator: 1,
    manager: 1,
    po: 1,
    developer: 2,
  });
  expect(admin.governance!.checks.find((c) => c.id === 'independent')!.ok).toBe(
    true,
  );
  expect((await financial('manager')).governance).toBeUndefined();
  // Tenant isolation and authentication.
  const foreign = await financial('foreign');
  expect(foreign.projects).toEqual([]);
  expect((await raw('', 'overview')).status).toBe(401);
  // Existing refusals unchanged.
  expect(
    (
      await raw('po', 'economics/reports', 'POST', {
        terms_id: scenario.terms.a,
        as_of: scenario.period.from,
      })
    ).status,
  ).toBe(403);
});
function engineInput(over: Partial<EconomicsInput> = {}): EconomicsInput {
  return {
    currency: 'BRL',
    period_from: '2026-11-01',
    period_until: '2026-11-30',
    as_of: '2026-11-15',
    regime: 'fixed_price',
    revenue: '100000',
    recognized: null,
    included_minutes: null,
    carry_in_minutes: 0,
    overage_rule: 'none',
    overage_rate: null,
    config: {
      tax_bps: 0,
      commission_bps: 0,
      overhead_rule: 'none_explicit',
      overhead_rate: null,
    },
    actuals: [],
    pending_minutes: 0,
    estimates: [
      {
        id: 'e',
        planned_minutes: 600,
        remaining_minutes: 600,
        rate: '6000',
        currency: 'BRL',
      },
    ],
    direct: [],
    capacity_minutes: 600,
    direct_costs_complete: true,
    time_entries_complete: true,
    projection_missing: [],
    actual_missing: [],
    alerts: [],
    ...over,
  };
}
test('health classification has no invented threshold and never treats absent as zero', () => {
  expect(assessHealth(null, 0, 0).health).toBe('unmeasured');
  expect(assessHealth(calculate(engineInput()), 0, 0).health).toBe('positive');
  // Any genuine margin stays positive: no target percentage is assumed.
  expect(
    assessHealth(
      calculate(
        engineInput({
          revenue: '60001',
          estimates: [
            {
              id: 'e',
              planned_minutes: 600,
              remaining_minutes: 600,
              rate: '6000',
              currency: 'BRL',
            },
          ],
        }),
      ),
      0,
      0,
    ).health,
  ).toBe('positive');
  expect(
    assessHealth(calculate(engineInput({ revenue: '60000' })), 0, 0).health,
  ).toBe('at_risk');
  expect(
    assessHealth(calculate(engineInput({ revenue: '59999' })), 0, 0).health,
  ).toBe('negative');
  expect(assessHealth(calculate(engineInput()), 1, 0).health).toBe('at_risk');
  expect(assessHealth(calculate(engineInput()), 0, 1).health).toBe('at_risk');
  expect(
    assessHealth(calculate(engineInput({ capacity_minutes: 599 })), 0, 0)
      .health,
  ).toBe('at_risk');
  for (const incomplete of [
    { config: null },
    { estimates: [] },
    { capacity_minutes: null },
    { pending_minutes: 1 },
    { time_entries_complete: false },
    { direct_costs_complete: false },
  ]) {
    const r = calculate(engineInput(incomplete));
    expect(r.projected_margin).toBeNull();
    expect(assessHealth(r, 0, 0).health).toBe('incomplete');
  }
});
test('labels: engine texts are translated and grouped; money and hours read exactly', () => {
  expect(
    humanMissing(['estimativa para item 1', 'estimativa para item 2']),
  ).toEqual([{ label: 'Estimativa aprovada de item do escopo', count: 2 }]);
  expect(humanMissing(['texto novo do motor'])[0]!.label).toBe(
    'texto novo do motor',
  );
  expect(moneyGrouped('105900000', 'BRL')).toBe('BRL 1.059.000,00');
  expect(moneyGrouped('-36000', 'BRL')).toBe('BRL -360,00');
  expect(moneyGrouped('1000', 'JPY')).toBe('JPY 1.000');
  expect(moneyGrouped(null, 'BRL')).toBe('Indisponível');
  expect(percentLabel('-50')).toBe('-0,50%');
  expect(percentLabel(null)).toBe('Indisponível');
  expect(hoursLabel(90)).toBe('1h30');
  expect(hoursLabel(-60)).toBe('-1h');
  expect(hoursLabel(null)).toBe('Indisponível');
});
