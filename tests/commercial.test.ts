import { dropDisposableDatabase } from './support/disposable';
import { beforeAll, afterAll, test, expect } from 'bun:test';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/server/app';
import { oidcProvider } from '../src/server/auth/oidc';
import { provisionRoles } from '../scripts/lib/provision-roles';
import { ident } from '../scripts/lib/privileges';
import { config, mockOidcFetch, codeFor } from './support/oidc-provider';
const name = `m3_${randomBytes(4).toString('hex')}_test`;
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
    `.local/commercial-${name}.env`,
  );
  const p = Bun.spawn(['node_modules/.bin/bun', 'scripts/migrate.ts'], {
    env: { ...process.env, ...roles },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  if ((await p.exited) !== 0) throw new Error('M3 migration failed');
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
    [foreign, 'foreign@catus.test', 'po', foreignOrg],
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
function scopeItem(extra: Record<string, unknown> = {}) {
  return {
    description: 'Checkout sintético',
    deliverables: 'Página de checkout',
    exclusions: 'Cupons e pagamento externo',
    acceptance_criteria: 'Fluxo de teste com carrinho sintético',
    dependencies: 'Arte aprovada pelo cliente',
    origin_interaction_id: interactionId,
    origin_request_id: null,
    ...extra,
  };
}
async function contractBody(project = projectId, client = clientId) {
  return {
    project_id: project,
    client_id: client,
    title: 'Contrato sintético M3',
    kind: 'fixed_price',
    currency: 'BRL',
    valid_from: '2020-01-01',
    valid_until: '2099-12-31',
    document_reference: 'SYNTHETIC-DOC-001',
  };
}
async function setPolicy(roles = ['manager', 'administrator'], v = 0) {
  const r = await call('admin', 'commercial/policy', 'POST', {
    version: v,
    approval_roles: roles,
  });
  expect(r.status).toBe(200);
  return r.json();
}
async function scope() {
  return (await (await call('po', 'commercial')).json()).scopes.find(
    (s: { id: string }) => s.id === scopeId,
  );
}
async function commercial(who = 'po') {
  const r = await call(who, 'commercial');
  expect(r.status).toBe(200);
  return r.json();
}
async function req(title: string) {
  return create('requests', {
    interaction_id: interactionId,
    title,
    description: 'Somente teste sintético',
    owner_user_id: dev,
    next_action: 'Revisar escopo comercial',
  });
}
test('M3 deny by default: no unauthenticated writes, developer/PO cannot grant authority, identity payload rejected', async () => {
  expect((await call('', 'commercial')).status).toBe(401);
  for (const who of ['po', 'dev', 'manager'])
    expect(
      (
        await call(who, 'commercial/policy', 'POST', {
          version: 0,
          approval_roles: ['manager'],
        })
      ).status,
    ).toBe(403);
  expect(
    (
      await call('admin', 'commercial/policy', 'POST', {
        version: 0,
        approval_roles: ['po'],
      })
    ).status,
  ).toBe(422);
  expect(
    (await call('dev', 'contracts', 'POST', await contractBody())).status,
  ).toBe(403);
  expect(
    (
      await call('po', 'contracts', 'POST', {
        ...(await contractBody()),
        role: 'administrator',
      })
    ).status,
  ).toBe(422);
  expect(
    (
      await call('po', 'contracts', 'POST', {
        ...(await contractBody()),
        amount: 100,
      })
    ).status,
  ).toBe(422);
  const csrf = actors.po!.csrf;
  actors.po!.csrf = 'invalid';
  expect(
    (await call('po', 'contracts', 'POST', await contractBody())).status,
  ).toBe(403);
  actors.po!.csrf = csrf;
});
test('contracts validate currency/dates/client-project identity; idempotent creation and immutable active terms', async () => {
  const c = await create('clients', { name: 'Second synthetic client' });
  secondProject = (
    await create('projects', {
      client_id: c.id,
      name: 'Second synthetic project',
    })
  ).id;
  for (const override of [
    { currency: 'ZZZ' },
    { kind: 'guessed' },
    { valid_from: '2026-02-30' },
    { valid_until: '2019-01-01' },
    { client_id: c.id },
  ])
    expect(
      (
        await call('po', 'contracts', 'POST', {
          ...(await contractBody()),
          ...override,
        })
      ).status,
    ).toBe(422);
  const body = await contractBody(),
    key = crypto.randomUUID();
  const a = await call('po', 'contracts', 'POST', body, key),
    b = await call('po', 'contracts', 'POST', body, key);
  expect(a.status).toBe(201);
  expect(b.status).toBe(201);
  const first = await a.json();
  contractId = first.id;
  expect((await b.json()).id).toBe(contractId);
  expect(
    (
      await call(
        'po',
        'contracts',
        'POST',
        { ...body, title: 'different' },
        key,
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await call('po', 'contracts/' + contractId, 'PATCH', {
        version: 1,
        state: 'active',
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await call('manager', 'contracts/' + contractId, 'PATCH', {
        version: 1,
        state: 'active',
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await call('manager', 'contracts/' + contractId, 'PATCH', {
        version: 1,
        state: 'closed',
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await call('manager', 'contracts/' + contractId, 'PATCH', {
        version: 2,
        title: 'rewrite',
      })
    ).status,
  ).toBe(409);
  await expect(
    runtime.query("UPDATE contracts SET currency='USD' WHERE id=$1", [
      contractId,
    ]),
  ).rejects.toThrow();
});
test('PO prepares source-grounded V1; one pending version; submission freezes contents; no policy denies decision', async () => {
  const body = {
    project_id: projectId,
    contract_id: contractId,
    title: 'Escopo V1 sintético',
    items: [scopeItem()],
  };
  expect(
    (
      await call('po', 'scopes', 'POST', {
        ...body,
        items: [scopeItem({ origin_interaction_id: null })],
      })
    ).status,
  ).toBe(422);
  expect(
    (await call('po', 'scopes', 'POST', { ...body, project_id: secondProject }))
      .status,
  ).toBe(404);
  const key = crypto.randomUUID(),
    r = await call('po', 'scopes', 'POST', body, key);
  expect(r.status).toBe(201);
  const s = await r.json();
  scopeId = s.id;
  itemId = s.items[0].id;
  expect(
    (await (await call('po', 'scopes', 'POST', body, key)).json()).id,
  ).toBe(scopeId);
  expect((await call('po', 'scopes', 'POST', body)).status).toBe(409);
  expect(
    (await call('po', 'scopes/' + scopeId + '/submit', 'POST', { version: 1 }))
      .status,
  ).toBe(200);
  expect(
    (
      await call('po', 'scopes/' + scopeId, 'PATCH', {
        version: 2,
        title: 'rewrite',
        contract_id: contractId,
        items: [scopeItem()],
      })
    ).status,
  ).toBe(409);
  await expect(
    runtime.query('DELETE FROM scope_items WHERE id=$1', [itemId]),
  ).rejects.toThrow();
  await expect(
    runtime.query("UPDATE scope_versions SET title='rewrite' WHERE id=$1", [
      scopeId,
    ]),
  ).rejects.toThrow();
  expect(
    (
      await call('manager', 'scopes/' + scopeId + '/decide', 'POST', {
        version: 2,
        decision: 'approved',
        reason: 'test',
      })
    ).status,
  ).toBe(403);
});
test('explicit role policy, PO/developer rejected; racing managers create exactly one approval with audit and idempotent replay', async () => {
  await setPolicy(['manager']);
  const body = {
    version: 2,
    decision: 'approved',
    reason: 'Documento sintético conferido pelo gestor',
  };
  for (const who of ['po', 'dev', 'admin'])
    expect(
      (await call(who, 'scopes/' + scopeId + '/decide', 'POST', body)).status,
    ).toBe(403);
  const key = crypto.randomUUID();
  const responses = await Promise.all([
    call('manager', 'scopes/' + scopeId + '/decide', 'POST', body, key),
    call('manager2', 'scopes/' + scopeId + '/decide', 'POST', body),
  ]);
  expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
  const winner = responses[0]!.status === 200 ? 'manager' : 'manager2';
  if (winner === 'manager')
    expect(
      (
        await call(
          'manager',
          'scopes/' + scopeId + '/decide',
          'POST',
          body,
          key,
        )
      ).status,
    ).toBe(200);
  expect(
    Number(
      (
        await db.query(
          'SELECT count(*) FROM scope_decisions WHERE scope_id=$1',
          [scopeId],
        )
      ).rows[0].count,
    ),
  ).toBe(1);
  const s = await scope();
  expect(s.state).toBe('approved');
  expect(s.decision.actor_role).toBe('manager');
  expect(s.decision.policy_roles).toEqual(['manager']);
  expect(s.decision.actor_user_id).toBe(
    winner === 'manager' ? manager : manager2,
  );
  const logs = (await commercial()).events.filter(
    (e: { entity_id: string; action: string }) =>
      e.entity_id === scopeId && e.action === 'approved',
  );
  expect(logs).toHaveLength(1);
  expect(logs[0].before_data.state).toBe('submitted');
  await expect(
    runtime.query(
      "UPDATE scope_decisions SET reason='tamper' WHERE scope_id=$1",
      [scopeId],
    ),
  ).rejects.toThrow();
  await expect(worker.query('SELECT * FROM contracts')).rejects.toThrow();
  await expect(
    worker.query("UPDATE scope_versions SET state='approved' WHERE id=$1", [
      scopeId,
    ]),
  ).rejects.toThrow();
});
test('ready is operational only: explicit covered and uncovered requests; invalid links rollback version and audit', async () => {
  const a = await req('Demanda coberta sintética'),
    b = await req('Fora de escopo sintética');
  coveredId = a.id;
  outsideId = b.id;
  let ver = 1;
  for (const status of ['triage', 'ready']) {
    expect(
      (
        await call('po', 'requests/' + b.id, 'PATCH', {
          version: ver++,
          status,
          owner_user_id: dev,
          next_action: 'Aguardar decisão comercial',
        })
      ).status,
    ).toBe(200);
  }
  const before = (await commercial()).events.length;
  expect(
    (
      await call('po', 'requests/' + coveredId + '/coverage', 'POST', {
        version: 1,
        scope_item_id: crypto.randomUUID(),
      })
    ).status,
  ).toBe(409);
  expect((await commercial()).events.length).toBe(before);
  expect(
    (
      await call('dev', 'requests/' + coveredId + '/coverage', 'POST', {
        version: 1,
        scope_item_id: itemId,
      })
    ).status,
  ).toBe(403);
  const key = crypto.randomUUID();
  const body = { version: 1, scope_item_id: itemId };
  expect(
    (await call('po', 'requests/' + coveredId + '/coverage', 'POST', body, key))
      .status,
  ).toBe(200);
  expect(
    (await call('po', 'requests/' + coveredId + '/coverage', 'POST', body, key))
      .status,
  ).toBe(200);
  const snapshot = await (await call('po', 'mission-control')).json();
  expect(
    snapshot.requests.find((r: { id: string }) => r.id === coveredId)
      .commercial_coverage,
  ).toBe('covered');
  const outside = snapshot.requests.find(
    (r: { id: string }) => r.id === outsideId,
  );
  expect(outside.status).toBe('ready');
  expect(outside.commercial_coverage).toBe('pending_analysis');
});
test('change request copies immutable V1 into V2, grants no automatic coverage, concurrent creation idempotent', async () => {
  const v1 = await scope(),
    body = {
      base_scope_id: scopeId,
      version: v1.version,
      reason: 'Adicionar cupom sintético',
      impact: 'Novo entregável e aceite; sem valores inferidos',
    },
    key = crypto.randomUUID();
  const [a, b] = await Promise.all([
    call('po', 'change-requests', 'POST', body, key),
    call('po', 'change-requests', 'POST', body, key),
  ]);
  expect(a.status).toBe(201);
  expect(b.status).toBe(201);
  const c = await a.json();
  expect((await b.json()).id).toBe(c.id);
  expect(c.scope.number).toBe(2);
  expect(c.scope.items[0].id).not.toBe(itemId);
  expect(await scope()).toEqual(v1);
  expect(
    (
      await call('po', 'requests/' + outsideId + '/coverage', 'POST', {
        version: 3,
        scope_item_id: c.scope.items[0].id,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await call('po', 'scopes/' + scopeId + '/revisions', 'POST', {
        version: v1.version,
      })
    ).status,
  ).toBe(409);
  const edited = await call('po', 'scopes/' + c.scope.id, 'PATCH', {
    version: 1,
    title: 'V2 com cupom',
    contract_id: contractId,
    items: [
      scopeItem({
        description: 'Checkout e cupom sintético',
        deliverables: 'Checkout e campo de cupom',
        exclusions: 'Pagamentos externos',
      }),
    ],
  });
  expect(edited.status).toBe(200);
  expect(
    (
      await call('po', 'scopes/' + c.scope.id + '/submit', 'POST', {
        version: 2,
      })
    ).status,
  ).toBe(200);
  const decision = await call(
    'manager',
    'scopes/' + c.scope.id + '/decide',
    'POST',
    {
      version: 3,
      decision: 'approved',
      reason: 'Ampliação sintética autorizada',
    },
  );
  expect(decision.status).toBe(200);
  const approved = await decision.json(),
    old = await scope();
  expect(old.state).toBe('superseded');
  expect(old.items).toEqual(v1.items);
  expect(old.decision).toEqual(v1.decision);
  expect(
    (await commercial()).changes.find((x: { id: string }) => x.id === c.id)
      .state,
  ).toBe('approved');
  let snapshot = await (await call('po', 'mission-control')).json();
  expect(
    snapshot.requests.find((r: { id: string }) => r.id === coveredId)
      .commercial_coverage,
  ).toBe('pending_analysis');
  expect(
    (
      await call('po', 'requests/' + outsideId + '/coverage', 'POST', {
        version: 3,
        scope_item_id: approved.items[0].id,
      })
    ).status,
  ).toBe(200);
  snapshot = await (await call('po', 'mission-control')).json();
  expect(
    snapshot.requests.find((r: { id: string }) => r.id === outsideId)
      .commercial_coverage,
  ).toBe('covered');
});
test('organization B cannot read/write A contracts/scopes/items, origins or policies; wrong project links rejected', async () => {
  const read = await call('po', 'commercial');
  expect(read.headers.get('content-security-policy')).toBe(
    "default-src 'none'",
  );
  const foreignView = await commercial('foreign');
  for (const field of ['contracts', 'scopes', 'changes', 'events'])
    expect(foreignView[field]).toEqual([]);
  expect(foreignView.policy).toBeNull();
  expect(
    (
      await call('foreign', 'contracts/' + contractId, 'PATCH', {
        version: 2,
        title: 'steal',
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await call('foreign', 'scopes/' + scopeId + '/submit', 'POST', {
        version: 4,
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await call('foreign', 'change-requests', 'POST', {
        base_scope_id: scopeId,
        version: 4,
        reason: 'x',
        impact: 'x',
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await call('foreign', 'requests/' + coveredId + '/coverage', 'POST', {
        version: 2,
        scope_item_id: itemId,
      })
    ).status,
  ).toBe(404);
  const fc = await (
    await call('foreign', 'clients', 'POST', { name: 'Foreign synthetic' })
  ).json();
  const fp = await (
    await call('foreign', 'projects', 'POST', {
      client_id: fc.id,
      name: 'Foreign synthetic',
    })
  ).json();
  const con = await (
    await call('foreign', 'contracts', 'POST', await contractBody(fp.id, fc.id))
  ).json();
  expect(
    (
      await call('foreign', 'scopes', 'POST', {
        project_id: fp.id,
        contract_id: con.id,
        title: 'foreign',
        items: [scopeItem()],
      })
    ).status,
  ).toBe(404);
  const otherInteraction = await create('interactions', {
    project_id: secondProject,
    kind: 'observation',
    summary: 'Other project synthetic',
    occurred_at: '2026-11-01T10:00:00Z',
  });
  const otherReq = await create('requests', {
    interaction_id: otherInteraction.id,
    title: 'Other project request',
    description: 'synthetic',
    owner_user_id: dev,
    next_action: 'scope',
  });
  expect(
    (
      await call('po', 'requests/' + otherReq.id + '/coverage', 'POST', {
        version: 1,
        scope_item_id: itemId,
      })
    ).status,
  ).toBe(409);
});
test('all preparers, including managers editing drafts, cannot self-approve; rejection and revisions preserve history', async () => {
  const client = await create('clients', { name: 'Self-approval synthetic' }),
    p = await create('projects', {
      client_id: client.id,
      name: 'Self approval project',
    });
  const interaction = await create('interactions', {
    project_id: p.id,
    kind: 'meeting',
    summary: 'Self approval synthetic',
    occurred_at: '2026-11-01T10:00:00Z',
  });
  const con = await (
    await call(
      'manager',
      'contracts',
      'POST',
      await contractBody(p.id, client.id),
    )
  ).json();
  expect(
    (
      await call('manager2', 'contracts/' + con.id, 'PATCH', {
        version: 1,
        state: 'active',
      })
    ).status,
  ).toBe(200);
  const s = await (
    await call('po', 'scopes', 'POST', {
      project_id: p.id,
      contract_id: con.id,
      title: 'Self approval',
      items: [scopeItem({ origin_interaction_id: interaction.id })],
    })
  ).json();
  expect(
    (
      await call('manager', 'scopes/' + s.id, 'PATCH', {
        version: 1,
        title: 'Edited by manager',
        contract_id: con.id,
        items: [scopeItem({ origin_interaction_id: interaction.id })],
      })
    ).status,
  ).toBe(200);
  expect(
    (await call('po', 'scopes/' + s.id + '/submit', 'POST', { version: 2 }))
      .status,
  ).toBe(200);
  const before = (await commercial()).events.length;
  expect(
    (
      await call('manager', 'scopes/' + s.id + '/decide', 'POST', {
        version: 3,
        decision: 'approved',
        reason: 'self',
      })
    ).status,
  ).toBe(403);
  expect((await commercial()).events.length).toBe(before);
  expect(
    (
      await call('manager2', 'scopes/' + s.id + '/decide', 'POST', {
        version: 3,
        decision: 'rejected',
        reason: 'Refinar dependências',
      })
    ).status,
  ).toBe(200);
  const revised = await call('po', 'scopes/' + s.id + '/revisions', 'POST', {
    version: 4,
  });
  expect(revised.status).toBe(201);
  const next = await revised.json();
  expect(next.previous_id).toBe(s.id);
  expect(next.number).toBe(2);
  expect(
    (await call('po', 'scopes/' + next.id + '/submit', 'POST', { version: 1 }))
      .status,
  ).toBe(200);
  expect(
    (
      await call('manager', 'scopes/' + next.id + '/decide', 'POST', {
        version: 2,
        decision: 'approved',
        reason: 'Copied work',
      })
    ).status,
  ).toBe(403);
});
test('contract closure removes coverage, does not rewrite requests/scope; policy versions prevent lost updates', async () => {
  expect(
    (
      await call('manager', 'contracts/' + contractId, 'PATCH', {
        version: 2,
        state: 'closed',
      })
    ).status,
  ).toBe(200);
  const snapshot = await (await call('po', 'mission-control')).json();
  const r = snapshot.requests.find((r: { id: string }) => r.id === outsideId);
  expect(r.scope_item_id).toBeTruthy();
  expect(r.commercial_coverage).toBe('pending_analysis');
  expect(
    (
      await call('po', 'requests/' + outsideId + '/coverage', 'POST', {
        version: r.version,
        scope_item_id: r.scope_item_id,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await call('admin', 'commercial/policy', 'POST', {
        version: 0,
        approval_roles: ['administrator'],
      })
    ).status,
  ).toBe(409);
  await setPolicy(['manager', 'administrator'], 1);
  expect(
    (
      await call('admin', 'commercial/policy', 'POST', {
        version: 1,
        approval_roles: ['administrator'],
      })
    ).status,
  ).toBe(409);
});
test('expired contracts block approval; failed audit rolls back decision, state and idempotency; rejected CR does not replace approved base', async () => {
  const p = await create('projects', {
      client_id: clientId,
      name: 'Expiry and atomicity synthetic',
    }),
    i = await create('interactions', {
      project_id: p.id,
      kind: 'conversation',
      summary: 'Synthetic expiry case',
      occurred_at: '2026-11-01T10:00:00Z',
    });
  const b = await contractBody(p.id, clientId);
  const c = await (
    await call('po', 'contracts', 'POST', {
      ...b,
      kind: 'retainer',
      valid_from: '2020-01-01',
      valid_until: '2020-12-31',
    })
  ).json();
  expect(
    (
      await call('manager', 'contracts/' + c.id, 'PATCH', {
        version: 1,
        state: 'active',
      })
    ).status,
  ).toBe(200);
  const s = await (
    await call('po', 'scopes', 'POST', {
      project_id: p.id,
      contract_id: c.id,
      title: 'Expired contract scope',
      items: [scopeItem({ origin_interaction_id: i.id })],
    })
  ).json();
  expect(
    (await call('po', 'scopes/' + s.id + '/submit', 'POST', { version: 1 }))
      .status,
  ).toBe(200);
  expect(
    (
      await call('manager', 'scopes/' + s.id + '/decide', 'POST', {
        version: 2,
        decision: 'approved',
        reason: 'Expired',
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await call('manager', 'scopes/' + s.id + '/decide', 'POST', {
        version: 2,
        decision: 'rejected',
        reason: 'Vigência inválida',
      })
    ).status,
  ).toBe(200);
  const good = await (await call('po', 'contracts', 'POST', b)).json();
  expect(
    (
      await call('manager', 'contracts/' + good.id, 'PATCH', {
        version: 1,
        state: 'active',
      })
    ).status,
  ).toBe(200);
  const revised = await (
    await call('po', 'scopes/' + s.id + '/revisions', 'POST', { version: 3 })
  ).json();
  expect(
    (
      await call('po', 'scopes/' + revised.id, 'PATCH', {
        version: 1,
        title: 'Revised contract scope',
        contract_id: good.id,
        items: [scopeItem({ origin_interaction_id: i.id })],
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await call('po', 'scopes/' + revised.id + '/submit', 'POST', {
        version: 2,
      })
    ).status,
  ).toBe(200);
  // Test-only failpoint in the disposable DB proves even a late audit error rolls back all prior writes.
  await db.query(
    `CREATE FUNCTION fail_test_commercial_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.entity_type='scope' AND NEW.action='approved' THEN RAISE EXCEPTION 'test audit unavailable' USING ERRCODE='23514'; END IF; RETURN NEW; END $$; CREATE TRIGGER test_commercial_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_test_commercial_audit()`,
  );
  const key = crypto.randomUUID(),
    decision = {
      version: 3,
      decision: 'approved',
      reason: 'Valid synthetic authorization',
    };
  try {
    expect(
      (
        await call(
          'manager',
          'scopes/' + revised.id + '/decide',
          'POST',
          decision,
          key,
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await db.query('SELECT state FROM scope_versions WHERE id=$1', [
          revised.id,
        ])
      ).rows[0].state,
    ).toBe('submitted');
    expect(
      (
        await db.query('SELECT 1 FROM scope_decisions WHERE scope_id=$1', [
          revised.id,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (await db.query('SELECT 1 FROM idempotency_keys WHERE key=$1', [key]))
        .rowCount,
    ).toBe(0);
  } finally {
    await db.query(
      'DROP TRIGGER test_commercial_audit ON audit_events; DROP FUNCTION fail_test_commercial_audit()',
    );
  }
  expect(
    (
      await call(
        'manager',
        'scopes/' + revised.id + '/decide',
        'POST',
        decision,
        key,
      )
    ).status,
  ).toBe(200);
  const cr = await (
    await call('po', 'change-requests', 'POST', {
      base_scope_id: revised.id,
      version: 4,
      reason: 'Synthetic unapproved expansion',
      impact: 'New scope needs explicit decision',
    })
  ).json();
  expect(
    (
      await call('po', 'scopes/' + cr.scope.id + '/submit', 'POST', {
        version: 1,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await call('manager', 'scopes/' + cr.scope.id + '/decide', 'POST', {
        version: 2,
        decision: 'rejected',
        reason: 'Do not expand',
      })
    ).status,
  ).toBe(200);
  const v = await commercial();
  expect(v.scopes.find((x: { id: string }) => x.id === revised.id).state).toBe(
    'approved',
  );
  expect(v.changes.find((x: { id: string }) => x.id === cr.id).state).toBe(
    'rejected',
  );
  expect(
    (
      await call('po', 'scopes/' + cr.scope.id + '/revisions', 'POST', {
        version: 3,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await call('po', 'change-requests', 'POST', {
        base_scope_id: revised.id,
        version: 4,
        reason: 'New manual attempt',
        impact: 'Review still required',
      })
    ).status,
  ).toBe(201);
});
test('incremental M2 → M3 migration preserves existing data and AI history and defaults requests to uncovered', async () => {
  const c = await db.connect();
  const schema = 'upgrade_' + randomBytes(4).toString('hex');
  const organization = '00000000-0000-4000-8000-000000000001';
  try {
    await c.query('BEGIN');
    await c.query(`CREATE SCHEMA ${ident(schema)}`);
    await c.query(`SET LOCAL search_path TO ${ident(schema)}`);
    for (const file of [
      '001_initial.sql',
      '002_identity.sql',
      '003_hardening.sql',
      '004_intelligent_intake.sql',
      '005_context_kinds.sql',
    ])
      await c.query(await Bun.file('db/migrations/' + file).text());
    const cid = crypto.randomUUID(),
      pid = crypto.randomUUID(),
      iid = crypto.randomUUID(),
      rid = crypto.randomUUID(),
      uid = crypto.randomUUID(),
      jid = crypto.randomUUID();
    await c.query(
      "INSERT INTO users(id,issuer,email,display_name) VALUES($1,'https://idp.test','legacy@synthetic.test','Legacy synthetic')",
      [uid],
    );
    await c.query(
      "INSERT INTO memberships(user_id,organization_id,role) VALUES($1,$2,'po')",
      [uid, organization],
    );
    await c.query(
      "INSERT INTO clients(id,name,organization_id) VALUES($1,'M2 synthetic preserved',$2)",
      [cid, organization],
    );
    await c.query(
      "INSERT INTO projects(id,client_id,name,organization_id) VALUES($1,$2,'M2 project',$3)",
      [pid, cid, organization],
    );
    await c.query(
      "INSERT INTO interactions(id,project_id,kind,summary,occurred_at,organization_id) VALUES($1,$2,'meeting','M2 conversation',now(),$3)",
      [iid, pid, organization],
    );
    await c.query(
      "INSERT INTO requests(id,interaction_id,title,description,status,owner,next_action,organization_id) VALUES($1,$2,'M2 request','Synthetic content','ready','Legacy name','Keep next action',$3)",
      [rid, iid, organization],
    );
    await c.query(
      "INSERT INTO audit_events(request_id,actor,action,organization_id,entity_id) VALUES($1,'legacy-actor','created',$2,$1)",
      [rid, organization],
    );
    await c.query(
      "INSERT INTO ai_budget_days(organization_id,day,jobs) VALUES($1,'2026-10-31',1)",
      [organization],
    );
    await c.query(
      "INSERT INTO extraction_jobs(id,organization_id,interaction_id,project_id,requested_by,idempotency_key,request_hash,source_text,source_hash,data_scope,policy_reference,provider_config,budget_day,reserved_micro_usd,state,result) VALUES($1,$2,$3,$4,$5,$6,'hash','Synthetic M2 text','source','synthetic','TEST','{}','2026-10-31',0,'succeeded','{\"original\":true}')",
      [jid, organization, iid, pid, uid, crypto.randomUUID()],
    );
    const beforeRequest = (await c.query('SELECT * FROM requests')).rows[0],
      beforeJobs = (await c.query('SELECT * FROM extraction_jobs')).rows,
      beforeAudit = (await c.query('SELECT * FROM audit_events')).rows;
    for (const file of [
      '006_scope_contracts.sql',
      '007_commercial_associations.sql',
    ])
      await c.query(await Bun.file('db/migrations/' + file).text());
    const after = (await c.query('SELECT * FROM requests')).rows[0];
    expect(after.scope_item_id).toBeNull();
    delete after.scope_item_id;
    expect(after).toEqual(beforeRequest);
    expect((await c.query('SELECT * FROM extraction_jobs')).rows).toEqual(
      beforeJobs,
    );
    expect((await c.query('SELECT * FROM audit_events')).rows).toEqual(
      beforeAudit,
    );
    expect((await c.query('SELECT * FROM contracts')).rows).toEqual([]);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});
