import { backup, restore } from '../scripts/lib/backup';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dropDisposableDatabase } from './support/disposable';
import { beforeAll, afterAll, test, expect } from 'bun:test';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/server/app';
import { oidcProvider } from '../src/server/auth/oidc';
import { provisionRoles } from '../scripts/lib/provision-roles';
import { ident } from '../scripts/lib/privileges';
import { config, mockOidcFetch, codeFor } from './support/oidc-provider';
const name = `m4_${randomBytes(4).toString('hex')}_test`;
const control = new URL(process.env.DATABASE_URL!);
control.pathname = '/postgres';
const target = new URL(control);
target.pathname = '/' + name;
const admin = new pg.Pool({ connectionString: control.href });
let db: pg.Pool, runtime: pg.Pool, worker: pg.Pool;
let app: ReturnType<typeof createApp>;
const org = crypto.randomUUID(),
  foreignOrg = crypto.randomUUID(),
  po = crypto.randomUUID(),
  dev = crypto.randomUUID(),
  foreign = crypto.randomUUID(),
  manager = crypto.randomUUID(),
  manager2 = crypto.randomUUID(),
  adminId = crypto.randomUUID();
const actors: Record<string, { cookie: string; csrf: string }> = {};
let interactionId = '',
  projectId = '',
  clientId = '';
let contractId = '',
  scopeId = '',
  itemId = '',
  coveredId = '',
  outsideId = '',
  secondProject = '';
async function call(
  who: string,
  path: string,
  method = 'GET',
  body?: unknown,
  key = crypto.randomUUID(),
) {
  const a = actors[who];
  return app(
    new Request(config.origin + '/api/' + path, {
      method,
      headers: {
        ...(a ? { Cookie: a.cookie, 'X-CSRF-Token': a.csrf } : {}),
        Origin: config.origin,
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    'commercial-tests',
  );
}
async function login(email: string) {
  const start = await call('', 'auth/login');
  const auth = new URL(start.headers.get('location')!);
  const callback = await app(
    new Request(
      `${config.origin}/api/auth/callback?state=${auth.searchParams.get('state')}&code=${codeFor(auth, email)}`,
      { headers: { Cookie: start.headers.getSetCookie()[0]!.split(';')[0]! } },
    ),
    'commercial-tests',
  );
  expect(callback.status).toBe(303);
  const cookie = callback.headers
    .getSetCookie()
    .find((s) => s.startsWith('catus_session='))!
    .split(';')[0]!;
  const session = await (
    await app(
      new Request(config.origin + '/api/session', {
        headers: { Cookie: cookie },
      }),
      'commercial-tests',
    )
  ).json();
  return { cookie, csrf: session.csrfToken as string };
}
async function create(path: string, body: unknown) {
  const res = await call('po', path, 'POST', body);
  expect(res.status).toBe(201);
  return res.json();
}
beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${ident(name)}`);
  const roles = await provisionRoles(
    target.href,
    `.local/economics-${name}.env`,
  );
  const p = Bun.spawn(['node_modules/.bin/bun', 'scripts/migrate.ts'], {
    env: { ...process.env, ...roles },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  if ((await p.exited) !== 0) throw new Error('M4 migration failed');
  db = new pg.Pool({ connectionString: target.href });
  runtime = new pg.Pool({ connectionString: roles.RUNTIME_DATABASE_URL });
  worker = new pg.Pool({
    connectionString: roles.AI_WORKER_DATABASE_URL,
    max: 4,
  });
  for (const pool of [db, runtime, worker])
    pool.on('error', () => {
      throw new Error('Unexpected idle test database failure');
    });
  await db.query('INSERT INTO organizations(id,name) VALUES($1,$2),($3,$4)', [
    org,
    'M2 synthetic',
    foreignOrg,
    'Foreign',
  ]);
  for (const [id, email, role, o] of [
    [po, 'po@catus.test', 'po', org],
    [dev, 'dev@catus.test', 'developer', org],
    [foreign, 'foreign@catus.test', 'manager', foreignOrg],
    [manager, 'manager@catus.test', 'manager', org],
    [manager2, 'manager2@catus.test', 'manager', org],
    [adminId, 'admin@catus.test', 'administrator', org],
  ]) {
    await db.query(
      'INSERT INTO users(id,issuer,email,display_name) VALUES($1,$2,$3,$3)',
      [id, config.oidc!.issuer, email],
    );
    await db.query(
      'INSERT INTO memberships(user_id,organization_id,role) VALUES($1,$2,$3)',
      [id, o, role],
    );
  }
  app = createApp(config, oidcProvider(config, await mockOidcFetch()), {
    pool: runtime,
    extractionProvider: null,
    loginRate: { limit: 1000, windowSeconds: 60 },
    apiRate: { limit: 1000, windowSeconds: 60 },
  });
  for (const k of ['po', 'dev', 'foreign', 'admin', 'manager', 'manager2'])
    actors[k] = await login(k + '@catus.test');
  const c = await create('clients', { name: 'Synthetic client' });
  const pjt = await create('projects', {
    client_id: c.id,
    name: 'Synthetic project',
  });
  projectId = pjt.id;
  clientId = c.id;
  interactionId = (
    await create('interactions', {
      project_id: projectId,
      kind: 'meeting',
      summary: 'SYNTHETIC M3: entregar checkout; cupons excluídos.',
      occurred_at: '2026-11-01T10:00:00Z',
    })
  ).id;
});
afterAll(async () => {
  await Promise.all([db?.end(), runtime?.end(), worker?.end()]);
  await dropDisposableDatabase(admin, name);
  for (const r of ['runtime', 'migrator', 'maintenance', 'aiworker'])
    await admin.query(`DROP ROLE IF EXISTS ${ident(name + '_' + r)}`);
  await admin.end();
});
let termsId = '',
  estimateId = '',
  timeId = '',
  rateId = '',
  reportId = '';
const from = '2026-11-01',
  until = '2026-11-30';
const configPayload = {
  tax_bps: 1000,
  commission_bps: 500,
  overhead_rule: 'per_labor_minute',
  overhead_minor_per_hour: '1200',
  weekdays: [1, 2, 3, 4, 5],
  minutes_per_day: 480,
  holidays: [],
};
function termsPayload(extra: Record<string, unknown> = {}) {
  return {
    contract_id: contractId,
    scope_id: scopeId,
    amount_minor: '1000000',
    recognition_rule: 'manual',
    recognized_minor: '400000',
    direct_costs_complete: true,
    time_entries_complete: true,
    included_minutes: null,
    overage_rule: 'none',
    overage_rate_minor: null,
    rollover_rule: 'none',
    rollover_cap_minutes: 0,
    carry_in_minutes: 0,
    prior_terms_id: null,
    change_request_id: null,
    ...extra,
  };
}
function recordBody(
  kind: string,
  payload: unknown,
  extra: Record<string, unknown> = {},
) {
  return {
    kind,
    project_id: ['config', 'rate'].includes(kind) ? null : projectId,
    currency: 'BRL',
    valid_from: from,
    valid_until: until,
    source: 'SYNTHETIC M4 source; no real salaries',
    payload,
    previous_id: null,
    ...extra,
  };
}
async function prep(
  kind: string,
  payload: unknown,
  extra: Record<string, unknown> = {},
  who = 'admin',
) {
  const r = await call(
    who,
    'economics/records',
    'POST',
    recordBody(kind, payload, extra),
  );
  expect(r.status).toBe(201);
  return r.json();
}
async function approve(
  r: { id: string; revision: number },
  who = 'manager',
  costRole: string | null = null,
) {
  const response = await call(
    who,
    'economics/records/' + r.id + '/decide',
    'POST',
    {
      revision: r.revision,
      decision: 'approved',
      reason: 'Synthetic independent approval',
      cost_role: costRole,
    },
  );
  expect(response.status).toBe(200);
  return response.json();
}
async function report(id = termsId) {
  const response = await call('manager', 'economics/reports', 'POST', {
    terms_id: id,
    as_of: from,
  });
  expect(response.status).toBe(201);
  return response.json();
}
async function view(who = 'manager') {
  return (await call(who, 'economics')).json();
}
beforeAll(async () => {
  expect(
    (
      await call('admin', 'commercial/policy', 'POST', {
        version: 0,
        approval_roles: ['manager', 'administrator'],
      })
    ).status,
  ).toBe(200);
  const contract = await create('contracts', {
    project_id: projectId,
    client_id: clientId,
    title: 'Synthetic M4 contract',
    kind: 'fixed_price',
    currency: 'BRL',
    valid_from: '2020-01-01',
    valid_until: '2099-12-31',
    document_reference: 'SYNTHETIC-M4',
  });
  contractId = contract.id;
  expect(
    (
      await call('manager', 'contracts/' + contractId, 'PATCH', {
        version: 1,
        state: 'active',
      })
    ).status,
  ).toBe(200);
  const scope = await create('scopes', {
    project_id: projectId,
    contract_id: contractId,
    title: 'M4 approved scope',
    items: [
      {
        description: 'Synthetic scope',
        deliverables: 'Synthetic checkout',
        exclusions: 'Real client data',
        acceptance_criteria: 'Synthetic evidence',
        dependencies: 'None declared',
        origin_interaction_id: interactionId,
        origin_request_id: null,
      },
    ],
  });
  scopeId = scope.id;
  itemId = scope.items[0].id;
  expect(
    (await call('po', 'scopes/' + scopeId + '/submit', 'POST', { version: 1 }))
      .status,
  ).toBe(200);
  expect(
    (
      await call('manager', 'scopes/' + scopeId + '/decide', 'POST', {
        version: 2,
        decision: 'approved',
        reason: 'Synthetic scope approved',
      })
    ).status,
  ).toBe(200);
  const req = await create('requests', {
    interaction_id: interactionId,
    title: 'M4 synthetic covered request',
    description: 'Synthetic',
    owner_user_id: dev,
    next_action: 'Estimate',
  });
  coveredId = req.id;
  expect(
    (
      await call('po', 'requests/' + coveredId + '/coverage', 'POST', {
        version: 1,
        scope_item_id: itemId,
      })
    ).status,
  ).toBe(200);
});
test('financial privacy, role and tenant boundaries: PO cannot change rates; developer cannot see private costs or write on behalf of another user', async () => {
  for (const who of ['po', 'dev'])
    expect(
      (
        await call(
          who,
          'economics/records',
          'POST',
          recordBody('rate', {
            user_id: dev,
            role: null,
            minor_per_hour: '6000',
          }),
        )
      ).status,
    ).toBe(403);
  expect(
    (
      await call('dev', 'economics/reports', 'POST', {
        terms_id: crypto.randomUUID(),
        as_of: from,
      })
    ).status,
  ).toBe(403);
  const f = await view('foreign');
  expect(f.records).toEqual([]);
  expect(f.times).toEqual([]);
  expect(f.reports).toEqual([]);
  expect(
    (
      await call('dev', 'economics/times', 'POST', {
        project_id: projectId,
        request_id: coveredId,
        user_id: po,
        work_date: from,
        minutes: 60,
        comment: 'forged',
      })
    ).status,
  ).toBe(422);
  for (const q of [
    'SELECT * FROM economic_records',
    'SELECT * FROM economic_reports',
    'INSERT INTO time_entries(id) VALUES(gen_random_uuid())',
  ])
    await expect(worker.query(q)).rejects.toThrow();
});
test('missing economic bases stay unavailable; independent decisions and exact integer validations required', async () => {
  const t = await prep('terms', termsPayload());
  termsId = t.id;
  expect(
    (
      await call('admin', 'economics/records/' + t.id + '/decide', 'POST', {
        revision: 1,
        decision: 'approved',
        reason: 'Self approval',
      })
    ).status,
  ).toBe(403);
  await approve(t);
  const r = await report();
  expect(r.result.projected_margin).toBeNull();
  expect(r.result.eac).toBeNull();
  expect(r.result.projection_missing).toContain(
    'configuração econômica/tributos/overhead',
  );
  expect(r.result.projection_missing).toContain('estimativas aprovadas');
  for (const amount of [1.1, 100, '-1', '1.10'])
    expect(
      (
        await call(
          'admin',
          'economics/records',
          'POST',
          recordBody('rate', {
            user_id: dev,
            role: null,
            minor_per_hour: amount,
          }),
        )
      ).status,
    ).toBe(422);
  const config = await prep('config', configPayload, {
    valid_from: '2026-01-01',
    valid_until: '2026-12-31',
  });
  await approve(config);
  const rate = await prep(
    'rate',
    { user_id: dev, role: null, minor_per_hour: '6000' },
    { valid_until: '2026-11-15' },
  );
  rateId = rate.id;
  await approve(rate);
  await expect(
    runtime.query("UPDATE economic_records SET currency='USD' WHERE id=$1", [
      rate.id,
    ]),
  ).rejects.toThrow();
});
test('PO estimates covered demand, developer logs exact minutes; concurrency/idempotency create one entry and decision', async () => {
  const e = await prep(
    'estimate',
    {
      terms_id: termsId,
      request_id: coveredId,
      user_id: dev,
      planned_minutes: 600,
      remaining_minutes: 480,
      expected_on: '2026-11-10',
    },
    {},
    'po',
  );
  estimateId = e.id;
  await approve(e);
  const capacity = await prep('capacity', {
    user_id: dev,
    available_minutes: 1000,
  });
  await approve(capacity);
  const expense = await prep('direct_cost', {
    terms_id: termsId,
    expense_key: 'SYNTHETIC-SERVICE-001',
    classification: 'external',
    budget_minor: '20000',
    incurred_minor: '5000',
    remaining_minor: '15000',
  });
  await approve(expense);
  const body = {
      project_id: projectId,
      request_id: coveredId,
      work_date: from,
      minutes: 120,
      comment: 'Synthetic 120 minutes',
    },
    key = crypto.randomUUID();
  const [a, b] = await Promise.all([
    call('dev', 'economics/times', 'POST', body, key),
    call('dev', 'economics/times', 'POST', body, key),
  ]);
  expect(a.status).toBe(201);
  expect(b.status).toBe(201);
  timeId = (await a.json()).id;
  expect((await b.json()).id).toBe(timeId);
  expect((await call('dev', 'economics/times', 'POST', body)).status).toBe(409);
  expect(
    (
      await call('dev', 'economics/times/' + timeId + '/action', 'POST', {
        expected_state: 'pending',
        action: 'approved',
        reason: 'self',
      })
    ).status,
  ).toBe(403);
  const before = await report();
  expect(before.result.pending_minutes).toBe(120);
  expect(before.result.cost_incurred).toBe('5000');
  expect(before.result.projected_margin).toBeNull();
  const action = {
    expected_state: 'pending',
    action: 'approved',
    reason: 'Synthetic evidence checked',
  };
  const decisions = await Promise.all([
    call('manager', 'economics/times/' + timeId + '/action', 'POST', action),
    call('manager2', 'economics/times/' + timeId + '/action', 'POST', action),
  ]);
  expect(decisions.map((x) => x.status).sort()).toEqual([200, 409]);
  const r = await report();
  reportId = r.id;
  expect(r.result.cost_incurred).toBe('19400');
  expect(r.result.eac).toBe('242000');
  expect(r.result.projected_margin).toBe('758000');
  expect(r.result.realized_margin).toBe('320600');
  expect(r.result.projection_missing).toEqual([]);
  const privateView = JSON.stringify(await view('dev'));
  for (const secret of [
    'minor_per_hour',
    'cost_minor',
    'recognized_minor',
    'tax_bps',
    'decision_snapshot',
  ])
    expect(privateView).not.toContain(secret);
  const poView = JSON.stringify(await view('po'));
  for (const secret of [
    'minor_per_hour',
    'cost_minor',
    'recognized_minor',
    'tax_bps',
    'decision_snapshot',
  ])
    expect(poView).not.toContain(secret);
});
test('remaining forecast changes EAC without rewriting actuals/reports; rate revisions preserve time/estimate snapshots', async () => {
  const first = (await view()).reports.find(
    (r: { id: string }) => r.id === reportId,
  );
  const e = await prep(
    'estimate',
    {
      terms_id: termsId,
      request_id: coveredId,
      user_id: dev,
      planned_minutes: 600,
      remaining_minutes: 1200,
      expected_on: '2026-11-10',
    },
    { previous_id: estimateId },
    'po',
  );
  estimateId = e.id;
  await approve(e);
  const r = await report();
  expect(r.result.eac).toBe('328400');
  expect(r.result.cost_incurred).toBe('19400');
  expect(r.result.realized_margin).toBe('320600');
  expect(r.result.alerts).toContain('Estouro previsto de horas');
  const updatedRate = await prep(
    'rate',
    { user_id: dev, role: null, minor_per_hour: '12000' },
    { previous_id: rateId, valid_until: '2026-11-15' },
  );
  await approve(updatedRate);
  const nextRate = await prep(
    'rate',
    { user_id: dev, role: null, minor_per_hour: '18000' },
    { valid_from: '2026-11-16' },
  );
  await approve(nextRate);
  const same = await report();
  expect(same.result.cost_incurred).toBe('19400');
  expect(same.result.eac).toBe('328400');
  const saved = (await view()).reports.find(
    (r: { id: string }) => r.id === reportId,
  );
  expect(saved).toEqual(first);
  const forward = await prep(
    'estimate',
    {
      terms_id: termsId,
      request_id: coveredId,
      user_id: dev,
      planned_minutes: 600,
      remaining_minutes: 1200,
      expected_on: '2026-11-20',
    },
    { previous_id: estimateId },
    'po',
  );
  await approve(forward);
  expect((await report()).result.eac).not.toBe('328400');
  expect(
    (
      await call(
        'foreign',
        'economics/records/' + forward.id + '/decide',
        'POST',
        { revision: forward.revision, decision: 'approved', reason: 'steal' },
      )
    ).status,
  ).toBe(404);
});
test('time corrections are reversals plus replacement, immutable audit and daily/date limits; no uncovered demand gains economics automatically', async () => {
  const body = {
    project_id: projectId,
    request_id: coveredId,
    work_date: from,
    minutes: 1440,
    comment: 'too many',
  };
  expect((await call('dev', 'economics/times', 'POST', body)).status).toBe(422);
  expect(
    (await call('dev', 'economics/times', 'POST', { ...body, minutes: 0 }))
      .status,
  ).toBe(422);
  expect(
    (
      await call('dev', 'economics/times', 'POST', {
        ...body,
        minutes: 1,
        work_date: '2099-01-01',
      })
    ).status,
  ).toBe(422);
  expect(
    (
      await call('dev', 'economics/times/' + timeId + '/action', 'POST', {
        expected_state: 'approved',
        action: 'reversed',
        reason: 'self approved correction',
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await call('manager', 'economics/times/' + timeId + '/action', 'POST', {
        expected_state: 'approved',
        action: 'reversed',
        reason: 'Synthetic correction of approved hours',
      })
    ).status,
  ).toBe(200);
  const replacement = await call('dev', 'economics/times', 'POST', {
    ...body,
    minutes: 60,
    comment: 'Synthetic replacement',
    replaces_id: timeId,
  });
  expect(replacement.status).toBe(201);
  const rr = await replacement.json();
  expect(
    (
      await call('manager', 'economics/times/' + rr.id + '/action', 'POST', {
        expected_state: 'pending',
        action: 'approved',
        reason: 'Correction checked',
      })
    ).status,
  ).toBe(200);
  expect((await report()).result.labor_incurred).toBe('12000'); // New explicit rate snapshot, original 120min reversed.
  await expect(
    runtime.query('DELETE FROM time_entries WHERE id=$1', [timeId]),
  ).rejects.toThrow();
  const uncovered = await create('requests', {
    interaction_id: interactionId,
    title: 'Uncovered M4',
    description: 'No contract coverage',
    owner_user_id: dev,
    next_action: 'Analyze',
  });
  expect(
    (
      await call(
        'po',
        'economics/records',
        'POST',
        recordBody('estimate', {
          terms_id: termsId,
          request_id: uncovered.id,
          user_id: dev,
          planned_minutes: 60,
          remaining_minutes: 60,
          expected_on: from,
        }),
      )
    ).status,
  ).toBe(409);
  const other = await call('dev', 'economics/times', 'POST', {
    project_id: projectId,
    request_id: uncovered.id,
    work_date: from,
    minutes: 30,
    comment: 'Work outside approved scope',
  });
  expect(other.status).toBe(201);
  const out = await other.json();
  expect(
    (
      await call('manager', 'economics/times/' + out.id + '/action', 'POST', {
        expected_state: 'pending',
        action: 'approved',
        reason: 'Record incurred cost, not scope authorization',
      })
    ).status,
  ).toBe(200);
  const reportOut = await report();
  expect(reportOut.result.alerts).toContain(
    'Horas em demanda sem cobertura comercial',
  );
  expect(reportOut.result.projected_margin).toBeNull();
});
test('retainer period balances, overage and capped rollover are explicit, approved and isolated from other competencies', async () => {
  const client = await create('clients', { name: 'Synthetic retainer client' }),
    p = await create('projects', {
      client_id: client.id,
      name: 'Synthetic retainer project',
    }),
    i = await create('interactions', {
      project_id: p.id,
      kind: 'meeting',
      summary: 'Synthetic retainer terms',
      occurred_at: '2026-09-01T10:00:00Z',
    });
  const c = await create('contracts', {
    project_id: p.id,
    client_id: client.id,
    title: 'Synthetic retainer',
    kind: 'retainer',
    currency: 'BRL',
    valid_from: '2020-01-01',
    valid_until: '2099-12-31',
    document_reference: 'SYNTHETIC-RETAINER',
  });
  expect(
    (
      await call('manager', 'contracts/' + c.id, 'PATCH', {
        version: 1,
        state: 'active',
      })
    ).status,
  ).toBe(200);
  const s = await create('scopes', {
    project_id: p.id,
    contract_id: c.id,
    title: 'Retainer approved scope',
    items: [
      {
        description: 'Retainer support',
        deliverables: 'Support',
        exclusions: 'Unapproved work',
        acceptance_criteria: 'Synthetic ticket closed',
        dependencies: 'None declared',
        origin_interaction_id: i.id,
        origin_request_id: null,
      },
    ],
  });
  expect(
    (await call('po', 'scopes/' + s.id + '/submit', 'POST', { version: 1 }))
      .status,
  ).toBe(200);
  expect(
    (
      await call('manager', 'scopes/' + s.id + '/decide', 'POST', {
        version: 2,
        decision: 'approved',
        reason: 'Synthetic retainer scope',
      })
    ).status,
  ).toBe(200);
  const q = await create('requests', {
    interaction_id: i.id,
    title: 'Synthetic support',
    description: 'Synthetic',
    owner_user_id: dev,
    next_action: 'Work within approved terms',
  });
  expect(
    (
      await call('po', 'requests/' + q.id + '/coverage', 'POST', {
        version: 1,
        scope_item_id: s.items[0].id,
      })
    ).status,
  ).toBe(200);
  const fallback = await prep(
    'rate',
    { user_id: null, role: 'developer', minor_per_hour: '6000' },
    { valid_from: '2026-09-01', valid_until: '2026-10-31' },
  );
  await approve(fallback);
  const pp = {
    contract_id: c.id,
    scope_id: s.id,
    amount_minor: '100000',
    recognition_rule: 'manual',
    recognized_minor: '100000',
    direct_costs_complete: true,
    time_entries_complete: true,
    included_minutes: 600,
    overage_rule: 'billable',
    overage_rate_minor: '6000',
    rollover_rule: 'carry_capped',
    rollover_cap_minutes: 120,
    carry_in_minutes: 0,
    prior_terms_id: null,
    change_request_id: null,
  };
  const september = await prep('terms', pp, {
    project_id: p.id,
    valid_from: '2026-09-01',
    valid_until: '2026-09-30',
  });
  await approve(september);
  const log = async (date: string, minutes: number) => {
    const res = await call('dev', 'economics/times', 'POST', {
      project_id: p.id,
      request_id: q.id,
      work_date: date,
      minutes,
      comment: 'Synthetic retainer ' + date,
    });
    expect(res.status).toBe(201);
    const t = await res.json();
    expect(
      (
        await call('manager', 'economics/times/' + t.id + '/action', 'POST', {
          expected_state: 'pending',
          action: 'approved',
          reason: 'Retainer evidence',
          cost_role: 'developer',
        })
      ).status,
    ).toBe(200);
    return t;
  };
  await log('2026-09-30', 480);
  expect(
    (
      await call(
        'admin',
        'economics/records',
        'POST',
        recordBody(
          'terms',
          { ...pp, carry_in_minutes: 121, prior_terms_id: september.id },
          {
            project_id: p.id,
            valid_from: '2026-10-01',
            valid_until: '2026-10-31',
          },
        ),
      )
    ).status,
  ).toBe(422);
  const october = await prep(
    'terms',
    { ...pp, carry_in_minutes: 120, prior_terms_id: september.id },
    { project_id: p.id, valid_from: '2026-10-01', valid_until: '2026-10-31' },
  );
  await approve(october);
  await log('2026-10-31', 780);
  const e = await prep(
    'estimate',
    {
      terms_id: october.id,
      request_id: q.id,
      user_id: dev,
      planned_minutes: 720,
      remaining_minutes: 0,
      expected_on: '2026-10-31',
    },
    { project_id: p.id, valid_from: '2026-10-01', valid_until: '2026-10-31' },
    'po',
  );
  await approve(e, 'manager', 'developer');
  const capacity = await prep(
    'capacity',
    { user_id: dev, available_minutes: 720 },
    { project_id: p.id, valid_from: '2026-10-01', valid_until: '2026-10-31' },
  );
  await approve(capacity);
  const response = await call('manager', 'economics/reports', 'POST', {
    terms_id: october.id,
    as_of: '2026-10-31',
  });
  expect(response.status).toBe(201);
  const r = (await response.json()).result;
  expect(r.approved_minutes).toBe(780);
  expect(r.carry_in_minutes).toBe(120);
  expect(r.balance_minutes).toBe(-60);
  expect(r.overage_minutes).toBe(60);
  expect(r.contracted_revenue).toBe('100000');
  expect(r.projected_revenue).toBe('106000');
  expect(r.eac).toBe('109500');
  expect(r.projected_margin).toBe('-3500');
  expect(r.period_from).toBe('2026-10-01');
  expect(r.period_until).toBe('2026-10-31');
  const november = await prep(
    'terms',
    {
      ...pp,
      amount_minor: '200000',
      recognized_minor: '0',
      prior_terms_id: october.id,
    },
    { project_id: p.id },
  );
  await approve(november);
  const n = await report(november.id);
  expect(n.result.approved_minutes).toBe(0);
  expect(n.result.contracted_revenue).toBe('200000');
  expect(n.result.projected_margin).toBeNull();
  const rollups = (await view()).clients;
  expect(
    rollups.some(
      (x: { period_from: string; contracted_revenue: string }) =>
        x.period_from === '2026-10-01' && x.contracted_revenue === '100000',
    ),
  ).toBe(true);
});
test('late audit failure rolls back approval and idempotency; overlapping periods/currencies and stale revision are rejected', async () => {
  const r = await prep('rate', {
      user_id: po,
      role: null,
      minor_per_hour: '1000',
    }),
    key = crypto.randomUUID(),
    body = { revision: 1, decision: 'approved', reason: 'Test rollback' };
  await db.query(
    `CREATE FUNCTION fail_m4_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.entity_type='economic_record' AND NEW.action='approved' THEN RAISE EXCEPTION 'test failure' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;CREATE TRIGGER fail_m4_test BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_m4_test_audit()`,
  );
  try {
    expect(
      (
        await call(
          'manager',
          'economics/records/' + r.id + '/decide',
          'POST',
          body,
          key,
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await db.query('SELECT 1 FROM economic_decisions WHERE record_id=$1', [
          r.id,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (await db.query('SELECT 1 FROM idempotency_keys WHERE key=$1', [key]))
        .rowCount,
    ).toBe(0);
  } finally {
    await db.query(
      'DROP TRIGGER fail_m4_test ON audit_events;DROP FUNCTION fail_m4_test_audit()',
    );
  }
  expect(
    (
      await call(
        'manager',
        'economics/records/' + r.id + '/decide',
        'POST',
        body,
        key,
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await call(
        'manager',
        'economics/records/' + r.id + '/decide',
        'POST',
        body,
        key,
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await call(
        'manager',
        'economics/records/' + r.id + '/decide',
        'POST',
        body,
      )
    ).status,
  ).toBe(409);
  const overlap = await prep(
    'rate',
    { user_id: po, role: null, minor_per_hour: '1000' },
    { valid_from: '2026-11-02', currency: 'USD' },
  );
  expect(
    (
      await call(
        'manager',
        'economics/records/' + overlap.id + '/decide',
        'POST',
        { revision: 1, decision: 'approved', reason: 'Ambiguous currency' },
      )
    ).status,
  ).toBe(409);
  const overcap = await prep(
    'capacity',
    { user_id: dev, available_minutes: 9999999 },
    {
      previous_id: (await view()).records.find(
        (x: { kind: string; project_id: string }) =>
          x.kind === 'capacity' && x.project_id === projectId,
      ).id,
    },
  );
  expect(
    (
      await call(
        'manager',
        'economics/records/' + overcap.id + '/decide',
        'POST',
        {
          revision: overcap.revision,
          decision: 'approved',
          reason: 'Impossible capacity',
        },
      )
    ).status,
  ).toBe(422); // Calendar guard rejects physically impossible allocation.
});
test('scope/contract expiration never grants new economic authority; late scope revision cannot silently expand terms', async () => {
  const res = await call('po', 'change-requests', 'POST', {
    base_scope_id: scopeId,
    version: 3,
    reason: 'Synthetic future scope',
    impact: 'Requires independent decision',
  });
  expect(res.status).toBe(201);
  const pending = await res.json();
  expect(
    (
      await call(
        'admin',
        'economics/records',
        'POST',
        recordBody(
          'terms',
          termsPayload({
            scope_id: pending.scope.id,
            change_request_id: pending.id,
          }),
          { previous_id: termsId },
        ),
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await call('manager', 'contracts/' + contractId, 'PATCH', {
        version: 2,
        state: 'closed',
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await call(
        'admin',
        'economics/records',
        'POST',
        recordBody('terms', termsPayload(), { previous_id: termsId }),
      )
    ).status,
  ).toBe(409);
  expect((await report()).result.projection_missing).toContain(
    'cobertura M3 atual/contrato vigente',
  );
});
test('backup/restore preserves M4 economic values, immutable history and deterministic recalculation in a disposable database', async () => {
  const restoreName = name.replace('_test', '_restore_test'),
    url = new URL(control);
  url.pathname = '/' + restoreName;
  const dir = '.local/m4-backup-' + name;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = dir + '/backup.key',
    archive = dir + '/economics.catus';
  writeFileSync(key, randomBytes(32), { mode: 0o600, flag: 'wx' });
  let restored: pg.Pool | undefined;
  await admin.query('CREATE DATABASE ' + ident(restoreName));
  const credentials = await provisionRoles(url.href, dir + '/restore.env');
  try {
    await backup(target.href, archive, key);
    await restore(
      credentials.MIGRATION_DATABASE_URL,
      archive,
      key,
      credentials.DB_RUNTIME_ROLE,
      credentials.DB_MAINTENANCE_ROLE,
    );
    restored = new pg.Pool({
      connectionString: credentials.MIGRATION_DATABASE_URL,
    });
    restored.on('error', () => {
      throw new Error('Unexpected restore pool failure');
    });
    for (const table of [
      'economic_records',
      'economic_decisions',
      'time_entries',
      'time_events',
      'economic_reports',
      'economic_events',
    ]) {
      const expected = (
        await db.query('SELECT * FROM ' + table + ' ORDER BY 1')
      ).rows;
      expect(expected.length).toBeGreaterThan(0);
      expect(
        (await restored.query('SELECT * FROM ' + table + ' ORDER BY 1')).rows,
      ).toEqual(expected);
    }
    const rows = (
      await restored.query(
        'SELECT inputs,result,input_hash FROM economic_reports',
      )
    ).rows;
    const { calculate } = await import('../src/server/economics/engine');
    const { inputHash } = await import('../src/server/economics/hash');
    for (const row of rows) {
      expect(calculate(row.inputs.engine_input)).toEqual(row.result);
      expect(inputHash(row.inputs)).toBe(row.input_hash);
    }
  } finally {
    await restored?.end();
    await dropDisposableDatabase(admin, restoreName);
    for (const r of ['runtime', 'migrator', 'maintenance', 'aiworker'])
      await admin.query('DROP ROLE IF EXISTS ' + ident(restoreName + '_' + r));
  }
}, 20000);
test('incremental M3 → M4 migration preserves approved commercial evidence without assigning economics', async () => {
  const c = await db.connect(),
    schema = 'm4upgrade_' + randomBytes(4).toString('hex');
  try {
    await c.query('BEGIN');
    await c.query('CREATE SCHEMA ' + ident(schema));
    await c.query('SET LOCAL search_path TO ' + ident(schema));
    for (const file of [
      '001_initial.sql',
      '002_identity.sql',
      '003_hardening.sql',
      '004_intelligent_intake.sql',
      '005_context_kinds.sql',
      '006_scope_contracts.sql',
      '007_commercial_associations.sql',
    ])
      await c.query(await Bun.file('db/migrations/' + file).text());
    const org = '00000000-0000-4000-8000-000000000001',
      u = crypto.randomUUID(),
      cl = crypto.randomUUID(),
      p = crypto.randomUUID(),
      ct = crypto.randomUUID(),
      sc = crypto.randomUUID();
    await c.query(
      "INSERT INTO users(id,issuer,email,display_name) VALUES($1,'https://synthetic.test','m3@synthetic.test','Synthetic M3 manager')",
      [u],
    );
    await c.query(
      "INSERT INTO memberships(user_id,organization_id,role) VALUES($1,$2,'manager')",
      [u, org],
    );
    await c.query(
      "INSERT INTO clients(id,name,organization_id) VALUES($1,'M3 client preserved',$2)",
      [cl, org],
    );
    await c.query(
      "INSERT INTO projects(id,client_id,name,organization_id) VALUES($1,$2,'M3 project preserved',$3)",
      [p, cl, org],
    );
    await c.query(
      "INSERT INTO contracts(id,organization_id,project_id,client_id,title,kind,currency,valid_from,valid_until,state,document_reference,created_by) VALUES($1,$2,$3,$4,'M3 preserved','fixed_price','BRL','2020-01-01','2099-12-31','active','SYNTHETIC-M3',$5)",
      [ct, org, p, cl, u],
    );
    await c.query(
      "INSERT INTO scope_versions(id,organization_id,project_id,contract_id,number,title,created_by) VALUES($1,$2,$3,$4,1,'M3 approved preserved',$5)",
      [sc, org, p, ct, u],
    );
    await c.query(
      "UPDATE scope_versions SET state='submitted',submitted_by=$2,submitted_at=now(),version=2 WHERE id=$1",
      [sc, u],
    );
    await c.query(
      "INSERT INTO scope_decisions(scope_id,organization_id,decision,actor_user_id,actor_role,policy_version,policy_roles,scope_version,reason) VALUES($1,$2,'approved',$3,'manager',1,ARRAY['manager'],2,'Synthetic preserved decision')",
      [sc, org, u],
    );
    await c.query(
      "UPDATE scope_versions SET state='approved',version=3 WHERE id=$1",
      [sc],
    );
    const before = (
      await c.query(
        'SELECT to_jsonb(s) scope,(SELECT to_jsonb(d) FROM scope_decisions d WHERE d.scope_id=s.id) decision FROM scope_versions s',
      )
    ).rows;
    await c.query(await Bun.file('db/migrations/008_economics.sql').text());
    expect(
      (
        await c.query(
          'SELECT to_jsonb(s) scope,(SELECT to_jsonb(d) FROM scope_decisions d WHERE d.scope_id=s.id) decision FROM scope_versions s',
        )
      ).rows,
    ).toEqual(before);
    expect((await c.query('SELECT * FROM economic_records')).rows).toEqual([]);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});
