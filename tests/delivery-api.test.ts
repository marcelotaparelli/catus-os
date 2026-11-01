import {
  fixtureRepository,
  fixtureAgent,
  themeIntakeFixture,
} from './support/delivery-fixture';
import { governedTask } from './support/delivery-governance';
import type { TestApi } from './support/delivery-governance';
import { fixtureProvider } from './support/extraction-fixture';
import { processOne } from '../src/server/ai/worker';
import { runnerCycle } from '../runner/src/core';
import type { Broker } from '../runner/src/core';
import { createHash, randomBytes } from 'node:crypto';
import { dropDisposableDatabase } from './support/disposable';
import { beforeAll, afterAll, test, expect } from 'bun:test';
import pg from 'pg';
import { createApp } from '../src/server/app';
import { oidcProvider } from '../src/server/auth/oidc';
import { provisionRoles } from '../scripts/lib/provision-roles';
import { ident } from '../scripts/lib/privileges';
import { config, mockOidcFetch, codeFor } from './support/oidc-provider';
const name = `m5_${randomBytes(4).toString('hex')}_test`;
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
let fixture: Awaited<ReturnType<typeof fixtureRepository>>,
  governed: Awaited<ReturnType<typeof governedTask>>;
const themeExtractor = fixtureProvider(() => themeIntakeFixture());
const runnerToken = randomBytes(32).toString('base64url');
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
    `.local/delivery-${name}.env`,
  );
  const p = Bun.spawn(['node_modules/.bin/bun', 'scripts/migrate.ts'], {
    env: { ...process.env, ...roles },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  if ((await p.exited) !== 0) throw new Error('M5 migration failed');
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
  fixture = await fixtureRepository();
  app = createApp(config, oidcProvider(config, await mockOidcFetch()), {
    pool: runtime,
    extractionProvider: themeExtractor,
    delivery: fixture.config,
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
  await fixture?.cleanup();
  await Promise.all([db?.end(), runtime?.end(), worker?.end()]);
  await dropDisposableDatabase(admin, name);
  for (const r of ['runtime', 'migrator', 'maintenance', 'aiworker'])
    await admin.query(`DROP ROLE IF EXISTS ${ident(name + '_' + r)}`);
  await admin.end();
});
const api: TestApi = async (who, path, body, method) => {
  const r = await call(
    who,
    path,
    method ?? (body === undefined ? 'GET' : 'POST'),
    body,
  );
  if (!r.ok)
    throw new Error(
      'Governance API failed ' +
        path +
        ' status ' +
        r.status +
        ' ' +
        JSON.stringify(await r.json()),
    );
  return r.json();
};
async function runner(path: string, body: unknown = {}) {
  return app(
    new Request(config.origin + '/api/delivery-runner/' + path, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + runnerToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
    'runner-tests',
  );
}
const broker: Broker = {
  claim: async () => {
    const r = await runner('claim');
    expect(r.status).toBe(200);
    return r.json();
  },
  post: async (job, action, body) => {
    const r = await runner('jobs/' + job + '/' + action, body);
    if (!r.ok) throw new Error('Runner API ' + r.status);
    return r.json();
  },
};
async function activate(
  enabled = true,
  version = 0,
  extra: Record<string, unknown> = {},
) {
  const r = await call('manager', 'delivery/policies', 'POST', {
    project_id: governed.projectId,
    version,
    enabled,
    settings: { ...fixture.settings, ...extra },
    reason: 'Autorizar somente Nuvemshop sintético; sem merge/deploy',
  });
  expect(r.status).toBe(200);
  return r.json();
}
beforeAll(async () => {
  governed = await governedTask(api, dev, async () => {
    await processOne(worker, themeExtractor);
  });
  await db.query(
    "INSERT INTO delivery_runners(id,organization_id,project_id,token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')",
    [
      crypto.randomUUID(),
      org,
      governed.projectId,
      createHash('sha256').update(runnerToken).digest('hex'),
    ],
  );
});
test('ready alone, default OFF, financial observation unapproved, forged role and unlisted repos never invoke a runner', async () => {
  const view = await (await call('po', 'delivery')).json();
  expect(view.jobs).toEqual([]);
  for (const who of ['po', 'dev'])
    expect(
      (
        await call(who, 'delivery/policies', 'POST', {
          project_id: governed.projectId,
          version: 0,
          enabled: true,
          settings: fixture.settings,
          reason: 'forged',
        })
      ).status,
    ).toBe(403);
  expect(
    (
      await call('manager', 'delivery/policies', 'POST', {
        project_id: governed.projectId,
        version: 0,
        enabled: true,
        settings: {
          ...fixture.settings,
          repository: 'https://github.com/other/production',
        },
        reason: 'not authorized',
      })
    ).status,
  ).toBe(422);
  expect(
    (
      await call('po', 'delivery/specs', 'POST', {
        request_id: governed.requestId,
        revision: 0,
        task_type: 'nuvemshop-theme',
        specification:
          'Corrigir título acessível Nuvemshop sintético sem alterar outros arquivos.',
        acceptance:
          'O h1 deve ser Bem-vindo à loja sintética; testes passando.',
        data_scope: 'synthetic',
        role: 'administrator',
      })
    ).status,
  ).toBe(422);
  await api('po', 'delivery/specs', {
    request_id: governed.requestId,
    revision: 0,
    task_type: 'nuvemshop-theme',
    specification:
      'Corrigir título acessível Nuvemshop sintético sem alterar outros arquivos.',
    acceptance: 'O h1 deve ser Bem-vindo à loja sintética; testes passando.',
    data_scope: 'synthetic',
  });
  await activate();
  const current = await (await call('po', 'delivery')).json();
  expect(current.jobs).toEqual([]);
  expect(
    current.eligibility.find(
      (e: { request_id: string }) => e.request_id === governed.requestId,
    ).reasons,
  ).toContain('Última observação M4 exige aprovação independente');
  expect(
    (
      await call(
        'manager',
        'delivery/reports/' + governed.reportId + '/approve',
        'POST',
        { reason: 'self' },
      )
    ).status,
  ).toBe(403);
});
test('M2 human request → approved M3/M4 → one automatically queued job; concurrent writes/retries do not duplicate', async () => {
  await api('admin', 'delivery/reports/' + governed.reportId + '/approve', {
    reason: 'Revisão independente completa das bases sintéticas para execução',
  });
  const snapshot = await (await call('manager', 'delivery')).json();
  expect(snapshot.jobs).toHaveLength(1);
  expect(snapshot.jobs[0].state).toBe('queued');
  expect(
    snapshot.eligibility.find(
      (e: { request_id: string }) => e.request_id === governed.requestId,
    ).eligible,
  ).toBe(true);
  const origin = (
    await db.query('SELECT origin_proposal_id FROM requests WHERE id=$1', [
      governed.requestId,
    ])
  ).rows[0];
  expect(origin.origin_proposal_id).toBe(governed.sourceProposalId);
  const claims = await Promise.all([runner('claim'), runner('claim')]);
  expect(claims.map((r) => r.status)).toEqual([200, 200]);
  const results = await Promise.all(claims.map((r) => r.json()));
  expect(results.filter((r) => r.task)).toHaveLength(1);
  const claimed = results.find((r) => r.task)!;
  expect(JSON.stringify(claimed)).not.toContain('minor_per_hour');
  expect(JSON.stringify(claimed)).not.toContain('contracted_revenue');
  expect(
    (
      await runner('jobs/' + claimed.task.job_id + '/start', {
        lease: claimed.lease,
      })
    ).status,
  ).toBe(200);
  const { executeTask } = await import('../runner/src/core');
  const evidence = await executeTask(
    claimed.task,
    fixture.repo,
    fixtureAgent,
    AbortSignal.timeout(20000),
  );
  const finish = await runner('jobs/' + claimed.task.job_id + '/finish', {
    lease: claimed.lease,
    result: evidence,
  });
  expect(finish.status).toBe(200);
  expect((await finish.json()).state).toBe('awaiting_review');
  expect(
    (
      await runner('jobs/' + claimed.task.job_id + '/finish', {
        lease: claimed.lease,
        result: evidence,
      })
    ).status,
  ).toBe(409);
  const done = await (await call('po', 'delivery')).json();
  expect(done.jobs[0].state).toBe('awaiting_review');
  expect(done.jobs[0].result.llm_verified).toBe(false);
  expect(done.jobs[0].result.patch).toContain('Bem-vindo');
  expect((await runner('claim')).json()).resolves.toEqual({ task: null });
  expect(
    (
      await call(
        'dev',
        'delivery/jobs/' + done.jobs[0].id + '/review',
        'POST',
        { decision: 'accepted', reason: 'not allowed' },
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await call(
        'foreign',
        'delivery/jobs/' + done.jobs[0].id + '/review',
        'POST',
        { decision: 'accepted', reason: 'cross tenant' },
      )
    ).status,
  ).toBe(404);
  await api('manager', 'delivery/jobs/' + done.jobs[0].id + '/review', {
    decision: 'accepted',
    reason: 'Diff e testes reais do runner fixture revisados; sem merge/deploy',
  });
  expect((await (await call('po', 'delivery')).json()).jobs[0].state).toBe(
    'completed',
  );
  expect(
    (
      await db.query('SELECT status FROM requests WHERE id=$1', [
        governed.requestId,
      ])
    ).rows[0].status,
  ).toBe('ready');
}, 30000);
test('policy revocation before claim releases reservation; no crash retry, cross-tenant service token or forged financial mutation', async () => {
  await api('po', 'delivery/specs', {
    request_id: governed.requestId,
    revision: 1,
    task_type: 'nuvemshop-theme',
    specification:
      'Nova correção sintética Nuvemshop requer novo aceite humano.',
    acceptance: 'Preservar o h1 acessível e retornar novo diff revisável.',
    data_scope: 'synthetic',
  });
  expect(
    (await (await call('manager', 'delivery')).json()).jobs.filter(
      (j: { state: string }) => j.state === 'queued',
    ),
  ).toHaveLength(1);
  await activate(false, 1);
  expect((await runner('claim')).status).toBe(200);
  expect((await (await call('manager', 'delivery')).json()).jobs[0].state).toBe(
    'blocked',
  );
  const policy = (
    await db.query(
      'SELECT id FROM delivery_policies WHERE organization_id=$1',
      [org],
    )
  ).rows[0];
  expect(
    (
      await db.query(
        'SELECT reserved_micro_usd FROM delivery_totals WHERE policy_id=$1',
        [policy.id],
      )
    ).rows[0].reserved_micro_usd,
  ).toBe('0');
  const forged = await app(
    new Request(config.origin + '/api/economics', {
      headers: { Authorization: 'Bearer ' + runnerToken },
    }),
    'runner-tests',
  );
  expect(forged.status).toBe(401);
  for (const sql of [
    'SELECT * FROM delivery_jobs',
    'UPDATE delivery_policies SET enabled=true',
  ])
    await expect(worker.query(sql)).rejects.toThrow();
});
async function newSpec() {
  const last = (
    await db.query(
      'SELECT max(revision) r FROM delivery_specs WHERE request_id=$1',
      [governed.requestId],
    )
  ).rows[0].r;
  return api('po', 'delivery/specs', {
    request_id: governed.requestId,
    revision: last,
    task_type: 'nuvemshop-theme',
    specification:
      'Correção Nuvemshop sintética explicitamente solicitada para nova revisão ' +
      (last + 1),
    acceptance:
      'Preservar a seção hero e confirmar h1 acessível com testes reais.',
    data_scope: 'synthetic',
  });
}
async function policyVersion() {
  return (
    await db.query(
      'SELECT version FROM delivery_policies WHERE project_id=$1',
      [governed.projectId],
    )
  ).rows[0].version;
}
test('economic threshold, exhausted budget, stale report and missing coverage block eligibility without harness calls', async () => {
  await activate(true, await policyVersion(), { min_margin_bps: 9999 });
  await newSpec();
  let view = await (await call('manager', 'delivery')).json();
  expect(
    view.eligibility.find(
      (e: { request_id: string }) => e.request_id === governed.requestId,
    ).reasons,
  ).toContain('Margem abaixo do limiar autorizado');
  expect(view.jobs.some((j: { state: string }) => j.state === 'queued')).toBe(
    false,
  );
  await activate(true, await policyVersion(), {
    min_margin_bps: 0,
    daily_budget_micro_usd: '100000',
    total_budget_micro_usd: '100000',
  });
  view = await (await call('manager', 'delivery')).json();
  const reasons = view.eligibility.find(
    (e: { request_id: string }) => e.request_id === governed.requestId,
  ).reasons;
  expect(reasons).toContain('Orçamento total indisponível');
  expect(reasons).toContain('Orçamento/limite diário indisponível');
  const original = Date.now;
  Date.now = () => original() + 241 * 60000;
  try {
    const stale = await (await call('manager', 'delivery')).json();
    expect(
      stale.eligibility.find(
        (e: { request_id: string }) => e.request_id === governed.requestId,
      ).reasons,
    ).toContain('Observação econômica vencida');
  } finally {
    Date.now = original;
  }
  const foreignView = await (await call('foreign', 'delivery')).json();
  expect(foreignView.jobs).toEqual([]);
  expect(foreignView.specs).toEqual([]);
  expect((await runner('claim')).json()).resolves.toEqual({ task: null });
});
test('claim crash is terminal, consumes reservation conservatively, never replays; revocation during execution cancels through heartbeat', async () => {
  await activate(true, await policyVersion(), { min_margin_bps: 0 }); // The prepared new revision automatically enters the queue.
  const claim = await (await runner('claim')).json();
  expect(claim.task).toBeTruthy();
  await db.query(
    "UPDATE delivery_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",
    [claim.task.job_id],
  );
  expect((await (await runner('claim')).json()).task).toBeNull();
  const failed = (
    await db.query('SELECT * FROM delivery_jobs WHERE id=$1', [
      claim.task.job_id,
    ])
  ).rows[0];
  expect(failed.state).toBe('failed');
  expect(failed.failure_code).toBe('runner_interrupted_requires_review');
  expect(failed.attempt).toBe(1);
  expect(failed.consumed_micro_usd).toBe(failed.reserved_micro_usd);
  await newSpec();
  let aborted = false,
    agentStarted = false;
  const inProgress = runnerCycle(broker, [fixture.repo], {
    kind: 'test-fixture',
    generate: async (_task, _sources, signal) =>
      new Promise((_, reject) => {
        agentStarted = true;
        if (signal.aborted) {
          aborted = true;
          reject(new Error('cancelled'));
          return;
        }
        signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(new Error('cancelled'));
          },
          { once: true },
        );
      }),
  });
  for (let i = 0; i < 100; i++) {
    if (
      (
        await db.query(
          "SELECT 1 FROM delivery_jobs WHERE organization_id=$1 AND state='running'",
          [org],
        )
      ).rowCount &&
      agentStarted
    )
      break;
    await Bun.sleep(20);
  }
  expect(agentStarted).toBe(true);
  await activate(false, await policyVersion());
  await inProgress;
  expect(aborted).toBe(true);
  const blocked = (
    await db.query(
      'SELECT * FROM delivery_jobs WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 1',
      [org],
    )
  ).rows[0];
  expect(blocked.state).toBe('blocked');
  expect(blocked.consumed_micro_usd).toBe(blocked.reserved_micro_usd);
  expect(
    (
      await runner('jobs/' + claim.task.job_id + '/heartbeat', {
        lease: 'forged',
      })
    ).status,
  ).toBe(409);
}, 15000);
test('malicious artifacts cannot forge paths, deploy commands, usage or a real Codex result', async () => {
  const { validateResult } = await import('../src/server/delivery/service');
  const result = (
    await db.query(
      'SELECT result FROM delivery_jobs WHERE result IS NOT NULL LIMIT 1',
    )
  ).rows[0].result;
  expect(() =>
    validateResult(
      {
        ...result,
        patch: 'diff --git a/.env b/.env\n+secret',
        files: ['templates/home.tpl'],
      },
      fixture.settings,
      true,
    ),
  ).toThrow();
  expect(() =>
    validateResult(
      {
        ...result,
        tests: [
          { argv: ['sh', '-c', 'deploy'], exit_code: 0, log: 'fake success' },
        ],
      },
      fixture.settings,
      true,
    ),
  ).toThrow();
  expect(() =>
    validateResult({ ...result, input_tokens: 999999 }, fixture.settings, true),
  ).toThrow();
  expect(() => validateResult(result, fixture.settings, false)).toThrow();
});
test('backup/restore preserves delivery evidence but invalidates running work and runner credentials without reactivation', async () => {
  const { backup, restore } = await import('../scripts/lib/backup');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  await activate(true, await policyVersion(), { min_margin_bps: 0 });
  await newSpec();
  const claimed = await (await runner('claim')).json();
  expect(claimed.task).toBeTruthy();
  await runner('jobs/' + claimed.task.job_id + '/start', {
    lease: claimed.lease,
  });
  const restoreName = name.replace('_test', '_restore_test'),
    url = new URL(control);
  url.pathname = '/' + restoreName;
  const dir = '.local/m5-backup-' + name;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = dir + '/backup.key',
    archive = dir + '/delivery.catus';
  writeFileSync(key, randomBytes(32), { mode: 0o600, flag: 'wx' });
  await admin.query('CREATE DATABASE ' + ident(restoreName));
  const creds = await provisionRoles(url.href, dir + '/restore.env');
  let restored: pg.Pool | undefined;
  try {
    await backup(target.href, archive, key);
    await restore(
      creds.MIGRATION_DATABASE_URL,
      archive,
      key,
      creds.DB_RUNTIME_ROLE,
      creds.DB_MAINTENANCE_ROLE,
    );
    restored = new pg.Pool({ connectionString: creds.MIGRATION_DATABASE_URL });
    restored.on('error', () => {
      throw new Error('Unexpected restore pool failure');
    });
    const restoredJob = (
      await restored.query(
        'SELECT state,failure_code FROM delivery_jobs WHERE id=$1',
        [claimed.task.job_id],
      )
    ).rows[0];
    expect(restoredJob).toEqual({
      state: 'failed',
      failure_code: 'restored_requires_review',
    });
    expect(
      (
        await restored.query(
          'SELECT 1 FROM delivery_runners WHERE revoked_at IS NULL',
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (await restored.query('SELECT * FROM delivery_reviews ORDER BY job_id'))
        .rows,
    ).toEqual(
      (await db.query('SELECT * FROM delivery_reviews ORDER BY job_id')).rows,
    );
    expect(
      (await restored.query('SELECT 1 FROM delivery_policies WHERE enabled'))
        .rowCount,
    ).toBe(0);
    const evidence = (
      await restored.query(
        'SELECT result FROM delivery_jobs WHERE result IS NOT NULL',
      )
    ).rows;
    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence).toEqual(
      (
        await db.query(
          'SELECT result FROM delivery_jobs WHERE result IS NOT NULL',
        )
      ).rows,
    );
    expect(
      (
        await restored.query('SELECT reserved_micro_usd FROM delivery_totals')
      ).rows.every((r) => r.reserved_micro_usd === '0'),
    ).toBe(true);
  } finally {
    await restored?.end();
    await dropDisposableDatabase(admin, restoreName);
    for (const r of ['runtime', 'migrator', 'maintenance', 'aiworker'])
      await admin.query('DROP ROLE IF EXISTS ' + ident(restoreName + '_' + r));
  }
  await activate(false, await policyVersion());
}, 25000);
test('closed contract and new financial changes block new work; credential is project scoped and denies arbitrary APIs', async () => {
  const raw = await call('po', 'requests/' + governed.requestId, 'PATCH', {
    version: 4,
    status: 'ready',
    owner_user_id: dev,
    next_action: 'Explicit new triage observation',
  });
  expect(raw.status).toBe(200);
  expect(
    (
      await call('manager', 'contracts/' + governed.contractId, 'PATCH', {
        version: 2,
        state: 'closed',
      })
    ).status,
  ).toBe(200);
  const e = (await (await call('po', 'delivery')).json()).eligibility.find(
    (e: { request_id: string }) => e.request_id === governed.requestId,
  );
  expect(e.reasons).toContain(
    'Cobertura M3 atual/contrato vigente obrigatórios',
  );
  const denied = await app(
    new Request(
      config.origin +
        '/api/delivery-runner/jobs/' +
        crypto.randomUUID() +
        '/start',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + runnerToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ lease: 'forged', role: 'administrator' }),
      },
    ),
    'runner-tests',
  );
  expect(denied.status).toBe(422);
});
test('offline scoped credential CLI writes only a private new file, stores digest, authenticates only broker and revokes without exposing value', async () => {
  const { readFileSync, statSync, unlinkSync } = await import('node:fs');
  const { parseEnv } = await import('node:util');
  await activate(true, await policyVersion(), { min_margin_bps: 0 });
  const file = '.local/runner-cli-' + name + '.env';
  const run = async (args: string[]) => {
    const p = Bun.spawn(
      [
        'node_modules/.bin/bun',
        '--no-env-file',
        'scripts/delivery-runner-token.ts',
        ...args,
      ],
      {
        env: { PATH: process.env.PATH, MIGRATION_DATABASE_URL: target.href },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const stdout = await new Response(p.stdout).text(),
      stderr = await new Response(p.stderr).text();
    return { code: await p.exited, stdout, stderr };
  };
  try {
    const provision = await run([org, governed.projectId, file]);
    expect(provision.code).toBe(0);
    expect(statSync(file).mode & 0o077).toBe(0);
    const token = parseEnv(readFileSync(file, 'utf8')).DELIVERY_RUNNER_TOKEN!;
    expect(token.length).toBe(43);
    expect(
      provision.stdout.includes(token) || provision.stderr.includes(token),
    ).toBe(false);
    const stored = (
      await db.query(
        'SELECT id,token_hash FROM delivery_runners WHERE token_hash=$1',
        [createHash('sha256').update(token).digest('hex')],
      )
    ).rows[0];
    expect(!!stored && stored.token_hash !== token).toBe(true);
    expect((await run([org, governed.projectId, file])).code).not.toBe(0);
    const request = () =>
      new Request(config.origin + '/api/delivery-runner/claim', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
    expect((await app(request(), 'credential-cli-test')).status).toBe(200);
    expect(
      (await run(['--revoke', org, governed.projectId, stored.id])).code,
    ).toBe(0);
    expect((await app(request(), 'credential-cli-test')).status).toBe(401);
    expect(
      Number(
        (
          await db.query(
            "SELECT count(*) n FROM delivery_events WHERE organization_id=$1 AND action='denied'",
            [org],
          )
        ).rows[0].n,
      ),
    ).toBeGreaterThan(0);
  } finally {
    try {
      unlinkSync(file);
    } catch {}
    await activate(false, await policyVersion());
  }
});
