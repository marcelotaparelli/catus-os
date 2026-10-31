import { dropDisposableDatabase } from './support/disposable';
import { test, expect, beforeAll, afterAll } from 'bun:test';
import pg from 'pg';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { provisionRoles } from '../scripts/lib/provision-roles';
import { ident, assertRuntimePrivileges } from '../scripts/lib/privileges';
import { createApp } from '../src/server/app';
import { oidcProvider } from '../src/server/auth/oidc';
import { config, mockOidcFetch, codeFor } from './support/oidc-provider';
import { cleanup } from '../src/server/maintenance';
import { backup, restore } from '../scripts/lib/backup';
import { webHandler } from '../src/server/http';
const name = `m11_${randomBytes(4).toString('hex')}_test`,
  restoreName = name.replace('_test', '_restore_test');
const adminUrl = new URL(process.env.DATABASE_URL!);
adminUrl.pathname = '/postgres';
const target = new URL(adminUrl);
target.pathname = '/' + name;
const restored = new URL(adminUrl);
restored.pathname = '/' + restoreName;
const admin = new pg.Pool({ connectionString: adminUrl.href });
let fixture: pg.Pool,
  runtime: pg.Pool,
  maintenance: pg.Pool,
  restoredPool: pg.Pool;
let creds: Awaited<ReturnType<typeof provisionRoles>>,
  restoreCreds: Awaited<ReturnType<typeof provisionRoles>>;
let app: ReturnType<typeof createApp>;
let cookie = '',
  csrf = '';
const org = crypto.randomUUID(),
  orgB = crypto.randomUUID(),
  user = crypto.randomUUID(),
  other = crypto.randomUUID();
const dir = `.local/operations-${name}`;
mkdirSync(dir, { recursive: true, mode: 0o700 });
async function call(
  path: string,
  method = 'GET',
  body?: unknown,
  key = crypto.randomUUID(),
  headers: Record<string, string> = {},
) {
  return app(
    new Request(config.origin + '/api/' + path, {
      method,
      headers: {
        Cookie: cookie,
        'X-CSRF-Token': csrf,
        Origin: config.origin,
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    'operations-peer',
  );
}
beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${ident(name)}`);
  await admin.query(`CREATE DATABASE ${ident(restoreName)}`);
  creds = await provisionRoles(target.href, dir + '/roles.env');
  restoreCreds = await provisionRoles(restored.href, dir + '/restore.env');
  const migration = Bun.spawn(['node_modules/.bin/bun', 'scripts/migrate.ts'], {
    env: { ...process.env, ...creds },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  if ((await migration.exited) !== 0) throw new Error('Test migration failed');
  fixture = new pg.Pool({ connectionString: target.href });
  runtime = new pg.Pool({ connectionString: creds.RUNTIME_DATABASE_URL });
  maintenance = new pg.Pool({
    connectionString: creds.MAINTENANCE_DATABASE_URL,
  });
  restoredPool = new pg.Pool({
    connectionString: restoreCreds.MIGRATION_DATABASE_URL,
  });
  for (const pool of [fixture, runtime, maintenance, restoredPool])
    pool.on('error', () => {
      throw new Error('Unexpected idle test database failure');
    });
  await fixture.query(
    'INSERT INTO organizations(id,name) VALUES($1,$2),($3,$4)',
    [org, 'Operations A', orgB, 'Operations B'],
  );
  await fixture.query(
    'INSERT INTO users(id,issuer,email,display_name) VALUES($1,$2,$3,$4),($5,$2,$6,$7)',
    [
      user,
      config.oidc!.issuer,
      'operator@catus.test',
      'Operator',
      other,
      'outside@catus.test',
      'Outside',
    ],
  );
  await fixture.query(
    "INSERT INTO memberships(user_id,organization_id,role) VALUES($1,$2,'po'),($3,$4,'po')",
    [user, org, other, orgB],
  );
  app = createApp(config, oidcProvider(config, await mockOidcFetch()), {
    pool: runtime,
  });
  const start = await call('auth/login');
  expect(start.status).toBe(303);
  const auth = new URL(start.headers.get('location')!);
  const state = start.headers.getSetCookie()[0]!.split(';')[0]!;
  const finish = await call(
    `auth/callback?state=${auth.searchParams.get('state')}&code=${codeFor(auth, 'operator@catus.test')}`,
    'GET',
    undefined,
    undefined,
    { Cookie: state },
  );
  expect(finish.status).toBe(303);
  cookie = finish.headers
    .getSetCookie()
    .find((c) => c.startsWith('catus_session='))!
    .split(';')[0]!;
  csrf = (await (await call('session')).json()).csrfToken;
});
afterAll(async () => {
  await Promise.all([
    fixture?.end(),
    runtime?.end(),
    maintenance?.end(),
    restoredPool?.end(),
  ]);
  for (const db of [name, restoreName]) await dropDisposableDatabase(admin, db);
  for (const db of [name, restoreName])
    for (const role of ['runtime', 'migrator', 'maintenance', 'aiworker'])
      await admin.query(`DROP ROLE IF EXISTS ${ident(db + '_' + role)}`);
  await admin.end();
});
test('runtime role works for app but cannot migrate, escalate or modify audit; maintenance cannot read business data', async () => {
  await assertRuntimePrivileges(runtime);
  for (const sql of [
    'CREATE TABLE forbidden(id int)',
    'ALTER TABLE clients ADD COLUMN forbidden text',
    'TRUNCATE clients',
    'DELETE FROM audit_events',
    "UPDATE audit_events SET actor='spoof'",
    'SELECT * FROM schema_migrations',
    `SET ROLE ${ident(name + '_migrator')}`,
    'CREATE ROLE forbidden',
  ])
    await expect(runtime.query(sql)).rejects.toMatchObject({ code: '42501' });
  await expect(
    maintenance.query('SELECT * FROM clients'),
  ).rejects.toMatchObject({ code: '42501' });
  const result = await provisionRoles(target.href, dir + '/roles.env');
  expect(result.RUNTIME_DATABASE_URL).toBe(creds.RUNTIME_DATABASE_URL);
});
let clientId = '';
test('idempotent creation survives concurrent retries/restart, rejects changed payload and preserves one audit event', async () => {
  const key = crypto.randomUUID();
  const responses = await Promise.all([
    call('clients', 'POST', { name: 'Idempotent Client' }, key),
    call('clients', 'POST', { name: 'Idempotent Client' }, key),
  ]);
  expect(responses.map((r) => r.status)).toEqual([201, 201]);
  const [a, b] = await Promise.all(responses.map((r) => r.json()));
  expect(a.id).toBe(b.id);
  clientId = a.id;
  expect(
    (
      await fixture.query(
        'SELECT count(*)::int n FROM audit_events WHERE entity_id=$1',
        [clientId],
      )
    ).rows[0].n,
  ).toBe(1);
  const original = app;
  app = createApp(config, oidcProvider(config, await mockOidcFetch()), {
    pool: runtime,
  });
  const retry = await call(
    'clients',
    'POST',
    { name: 'Idempotent Client' },
    key,
  );
  expect(retry.headers.get('idempotency-replayed')).toBe('true');
  expect((await retry.json()).id).toBe(clientId);
  expect((await call('clients', 'POST', { name: 'Changed' }, key)).status).toBe(
    409,
  );
  expect(
    (
      await call('clients', 'POST', { name: 'Missing' }, undefined, {
        'Idempotency-Key': '',
      })
    ).status,
  ).toBe(400);
  const failedKey = crypto.randomUUID();
  expect((await call('clients', 'POST', { name: ' ' }, failedKey)).status).toBe(
    422,
  );
  expect(
    (await call('clients', 'POST', { name: 'After rollback' }, failedKey))
      .status,
  ).toBe(201);
  app = original;
});
test('limited runtime preserves M0 workflow, tenant authorization and idempotency of all creation routes', async () => {
  async function create(route: string, body: unknown) {
    const key = crypto.randomUUID();
    const a = await call(route, 'POST', body, key);
    expect(a.status).toBe(201);
    const result = await a.json();
    expect((await (await call(route, 'POST', body, key)).json()).id).toBe(
      result.id,
    );
    return result;
  }
  const project = await create('projects', {
    client_id: clientId,
    name: 'Operations project',
  });
  const interaction = await create('interactions', {
    project_id: project.id,
    kind: 'meeting',
    summary: 'Context',
    occurred_at: '2026-10-31T10:00:00Z',
  });
  const request = await create('requests', {
    interaction_id: interaction.id,
    title: 'Real request',
    description: 'Preserve on restore',
    owner_user_id: user,
    next_action: 'Review',
  });
  expect(
    (
      await call('requests/' + request.id, 'PATCH', {
        status: 'triage',
        owner_user_id: user,
        next_action: 'Estimate',
        version: 1,
      })
    ).status,
  ).toBe(200);
  const foreign = crypto.randomUUID();
  await fixture.query(
    'INSERT INTO clients(id,organization_id,name) VALUES($1,$2,$3)',
    [foreign, orgB, 'Other org secret'],
  );
  expect(
    (await call('projects', 'POST', { client_id: foreign, name: 'Attack' }))
      .status,
  ).toBe(404);
  expect(
    JSON.stringify(await (await call('mission-control')).json()),
  ).not.toContain('Other org secret');
  const audit = (
    await fixture.query(
      'SELECT actor_user_id FROM audit_events WHERE request_id=$1 ORDER BY id DESC LIMIT 1',
      [request.id],
    )
  ).rows[0];
  expect(audit.actor_user_id).toBe(user);
});
test('rate limit is atomic/persistent, counts denied requests and ignores spoofed forwarding headers', async () => {
  const c = { origin: config.origin, secureCookies: false };
  const options = {
    pool: runtime,
    loginRate: { limit: 2, windowSeconds: 60 },
    apiRate: { limit: 2, windowSeconds: 60 },
  };
  const a = createApp(c, undefined, options),
    b = createApp(c, undefined, options);
  const req = new Request(config.origin + '/api/auth/config');
  expect((await a(req, 'limited-peer')).status).toBe(200);
  expect((await b(req, 'limited-peer')).status).toBe(200);
  const denied = await a(
    new Request(req, { headers: { 'X-Forwarded-For': 'different-peer' } }),
    'limited-peer',
  );
  expect(denied.status).toBe(429);
  expect(Number(denied.headers.get('retry-after'))).toBeGreaterThan(0);
  expect((await b(req, 'limited-peer')).status).toBe(429);
  expect((await b(req, 'different-peer')).status).toBe(200);
  await fixture.query(
    "UPDATE rate_limits SET window_started_at=now()-interval '2 minutes'",
  );
  expect((await b(req, 'limited-peer')).status).toBe(200);
  const failures = new Request(config.origin + '/api/clients');
  expect((await a(failures, 'failed-peer')).status).toBe(503);
  expect((await b(failures, 'failed-peer')).status).toBe(503);
  expect((await a(failures, 'failed-peer')).status).toBe(429);
});
test('encrypted pg_dump restores business data/audit into a fresh database, rejects tampering and invalidates sessions', async () => {
  const keyFile = dir + '/backup.key',
    archive = dir + '/backup.catus';
  writeFileSync(keyFile, randomBytes(32), { mode: 0o600, flag: 'wx' });
  const context = (
    await fixture.query(
      'SELECT id,project_id FROM interactions WHERE organization_id=$1 LIMIT 1',
      [org],
    )
  ).rows[0];
  const queuedId = crypto.randomUUID();
  await fixture.query(
    "INSERT INTO ai_budget_days(organization_id,day,reserved_micro_usd,jobs) VALUES($1,(now() AT TIME ZONE 'UTC')::date,1000,1)",
    [org],
  );
  await fixture.query(
    "INSERT INTO extraction_jobs(id,organization_id,interaction_id,project_id,requested_by,idempotency_key,request_hash,source_text,source_hash,data_scope,policy_reference,provider_config,budget_day,reserved_micro_usd) VALUES($1,$2,$3,$4,$5,$6,'test-hash','Synthetic restore source','test-source','synthetic','test-policy','{}',(now() AT TIME ZONE 'UTC')::date,1000)",
    [queuedId, org, context.id, context.project_id, user, crypto.randomUUID()],
  );
  const saved = await backup(creds.MIGRATION_DATABASE_URL!, archive, keyFile);
  expect(saved.bytes).toBeGreaterThan(100);
  expect(readFileSync(archive).includes(Buffer.from('Idempotent Client'))).toBe(
    false,
  );
  await expect(
    backup(creds.MIGRATION_DATABASE_URL!, archive, keyFile),
  ).rejects.toThrow('already exists');
  const damaged = Buffer.from(readFileSync(archive));
  damaged[30] = damaged[30]! ^ 1;
  writeFileSync(dir + '/damaged.catus', damaged, { mode: 0o600 });
  await expect(
    restore(
      restoreCreds.MIGRATION_DATABASE_URL!,
      dir + '/damaged.catus',
      keyFile,
      restoreCreds.DB_RUNTIME_ROLE!,
      restoreCreds.DB_MAINTENANCE_ROLE!,
    ),
  ).rejects.toThrow();
  expect(
    (
      await restoredPool.query(
        "SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'",
      )
    ).rows[0].n,
  ).toBe(0);
  expect(
    await restore(
      restoreCreds.MIGRATION_DATABASE_URL!,
      archive,
      keyFile,
      restoreCreds.DB_RUNTIME_ROLE!,
      restoreCreds.DB_MAINTENANCE_ROLE!,
    ),
  ).toMatchObject({ restored: true, sessionsInvalidated: true });
  for (const table of [
    'clients',
    'projects',
    'interactions',
    'requests',
    'audit_events',
    'users',
    'memberships',
  ])
    expect(
      (await restoredPool.query(`SELECT * FROM ${table} ORDER BY 1`)).rows,
    ).toEqual((await fixture.query(`SELECT * FROM ${table} ORDER BY 1`)).rows);
  expect(
    (await restoredPool.query('SELECT count(*)::int n FROM sessions')).rows[0]
      .n,
  ).toBe(0);
  expect(
    (await restoredPool.query('SELECT count(*)::int n FROM idempotency_keys'))
      .rows[0].n,
  ).toBe(0);
  expect(
    (
      await restoredPool.query(
        'SELECT state,failure_code FROM extraction_jobs WHERE id=$1',
        [queuedId],
      )
    ).rows[0],
  ).toMatchObject({
    state: 'failed',
    failure_code: 'restored_requires_review',
  });
  expect(
    (
      await restoredPool.query(
        'SELECT reserved_micro_usd,spent_micro_usd FROM ai_budget_days WHERE organization_id=$1',
        [org],
      )
    ).rows[0],
  ).toMatchObject({ reserved_micro_usd: '0', spent_micro_usd: '1000' });
  await expect(
    restore(
      restoreCreds.MIGRATION_DATABASE_URL!,
      archive,
      keyFile,
      restoreCreds.DB_RUNTIME_ROLE!,
      restoreCreds.DB_MAINTENANCE_ROLE!,
    ),
  ).rejects.toThrow('must be empty');
}, 60000);
test('cleanup uses limited maintenance role, bounded batches and preserves active sessions and audit', async () => {
  const count = (
    await fixture.query('SELECT count(*)::int n FROM audit_events')
  ).rows[0].n;
  await fixture.query(
    "UPDATE sessions SET expires_at=now()-interval '1 second'",
  );
  await fixture.query(
    "UPDATE oidc_transactions SET expires_at=now()-interval '1 second'",
  );
  await fixture.query(
    "UPDATE idempotency_keys SET expires_at=now()-interval '1 second'",
  );
  await fixture.query(
    'INSERT INTO sessions(id,token_hash,csrf_token,user_id,organization_id) VALUES($1,$2,$3,$4,$5)',
    [
      crypto.randomUUID(),
      randomBytes(32).toString('hex'),
      'active-csrf',
      user,
      org,
    ],
  );
  const first = await cleanup(maintenance, 1);
  expect(first.sessions).toBe(1);
  expect(first.keys).toBe(1);
  await cleanup(maintenance);
  expect((await cleanup(maintenance)).sessions).toBe(0);
  expect((await call('session')).status).toBe(401);
  expect(
    (await fixture.query('SELECT count(*)::int n FROM sessions')).rows[0].n,
  ).toBe(1);
  expect(
    (await fixture.query('SELECT count(*)::int n FROM audit_events')).rows[0].n,
  ).toBe(count);
});
test('HTTPS serves build with trusted local CA, secure OIDC/session cookies and CSRF without disabling verification', async () => {
  const c = { ...config, secureCookies: true, origin: 'https://localhost:0' };
  let handler: (req: Request, peer: string) => Promise<Response>;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    tls: {
      cert: Bun.file('.local/tls/server.crt'),
      key: Bun.file('.local/tls/server.key'),
    },
    fetch: (r) => handler(r, 'tls-peer'),
  });
  c.origin = `https://localhost:${server.port}`;
  handler = webHandler(
    createApp(c, oidcProvider(c, await mockOidcFetch()), { pool: runtime }),
    c,
  );
  const tls = {
    ca: await Bun.file('.local/tls/ca.crt').text(),
    rejectUnauthorized: true,
  };
  try {
    await expect(fetch(c.origin + '/')).rejects.toThrow();
    const index = await fetch(c.origin + '/', { tls });
    expect(index.status).toBe(200);
    expect(index.headers.get('content-security-policy')).toContain(
      "frame-ancestors 'none'",
    );
    const start = await fetch(c.origin + '/api/auth/login', {
      tls,
      redirect: 'manual',
    });
    expect(start.status).toBe(303);
    expect(start.headers.getSetCookie()[0]).toContain('__Host-catus_oidc=');
    expect(start.headers.getSetCookie()[0]).toContain('; Secure');
    const auth = new URL(start.headers.get('location')!);
    const finish = await fetch(
      c.origin +
        `/api/auth/callback?state=${auth.searchParams.get('state')}&code=${codeFor(auth, 'operator@catus.test')}`,
      {
        tls,
        redirect: 'manual',
        headers: { Cookie: start.headers.getSetCookie()[0]!.split(';')[0]! },
      },
    );
    expect(finish.status).toBe(303);
    const sessionCookie = finish.headers
      .getSetCookie()
      .find((s) => s.startsWith('__Host-catus_session='))!;
    expect(sessionCookie).toContain('HttpOnly');
    expect(sessionCookie).toContain('; Secure');
    const headers = { Cookie: sessionCookie.split(';')[0]! };
    const session = await (
      await fetch(c.origin + '/api/session', { tls, headers })
    ).json();
    expect(session.user.id).toBe(user);
    const denied = await fetch(c.origin + '/api/clients', {
      tls,
      method: 'POST',
      headers: {
        ...headers,
        Origin: c.origin,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Missing CSRF' }),
    });
    expect(denied.status).toBe(403);
  } finally {
    await server.stop(true);
  }
});
