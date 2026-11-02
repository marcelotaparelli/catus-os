import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createApp } from '../src/server/app';
import { pool } from '../src/server/db';
import { oidcProvider } from '../src/server/auth/oidc';
import { config, mockOidcFetch, codeFor } from './support/oidc-provider';
import { cookieName, hash } from '../src/server/auth/cookies';
import type { Role, SessionView } from '../src/shared/identity';
import { readFile } from 'node:fs/promises';
const orgA = crypto.randomUUID(),
  orgB = crypto.randomUUID();
const ids: Record<string, string> = {};
let app: ReturnType<typeof createApp>;
interface Actor {
  cookie: string;
  csrf: string;
  id: string;
}
const actors: Record<string, Actor> = {};
async function call(
  actor: Actor | undefined,
  path: string,
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return app(
    new Request(`${config.origin}/api/${path}`, {
      method,
      headers: {
        ...(actor ? { Cookie: actor.cookie, 'X-CSRF-Token': actor.csrf } : {}),
        Origin: config.origin,
        'Content-Type': 'application/json',
        'Idempotency-Key': crypto.randomUUID(),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
async function login(email: string, failure?: Parameters<typeof codeFor>[2]) {
  const start = await call(undefined, 'auth/login');
  expect(start.status).toBe(303);
  const auth = new URL(start.headers.get('location')!);
  const state = auth.searchParams.get('state')!;
  const cookie = start.headers.getSetCookie()[0]!.split(';')[0]!;
  const result = await call(
    undefined,
    `auth/callback?state=${state}&code=${codeFor(auth, email, failure)}`,
    'GET',
    undefined,
    { Cookie: cookie },
  );
  return { result, auth, cookie, state };
}
async function actor(email: string) {
  const { result } = await login(email);
  expect(result.status).toBe(303);
  const cookie = result.headers
    .getSetCookie()
    .find((v) => v.startsWith(cookieName(config, 'session') + '='))!
    .split(';')[0]!;
  const session = (await (
    await call({ cookie, csrf: '', id: '' }, 'session')
  ).json()) as SessionView;
  return { cookie, csrf: session.csrfToken, id: session.user.id };
}
async function create(who: Actor, path: string, body: unknown) {
  const result = await call(who, path, 'POST', body);
  expect(result.status).toBe(201);
  return await result.json();
}
let requestId: string;
let interactionId: string;
beforeAll(async () => {
  app = createApp(config, oidcProvider(config, await mockOidcFetch()), {
    loginRate: { limit: 1000, windowSeconds: 60 },
    apiRate: { limit: 5000, windowSeconds: 60 },
  });
  await pool.query(
    'TRUNCATE rate_limits,idempotency_keys,audit_events,sessions,oidc_transactions,requests,interactions,projects,clients,memberships,users,organizations CASCADE',
  );
  await pool.query('INSERT INTO organizations(id,name) VALUES($1,$2),($3,$4)', [
    orgA,
    'Test A',
    orgB,
    'Test B',
  ]);
  for (const [key, role, org] of [
    ['admin', 'administrator', orgA],
    ['manager', 'manager', orgA],
    ['po', 'po', orgA],
    ['dev', 'developer', orgA],
    ['other', 'po', orgB],
  ] as [string, Role, string][]) {
    const id = crypto.randomUUID();
    ids[key] = id;
    await pool.query(
      'INSERT INTO users(id,issuer,email,display_name) VALUES($1,$2,$3,$4)',
      [id, config.oidc!.issuer, `${key}@catus.test`, key],
    );
    await pool.query(
      'INSERT INTO memberships(user_id,organization_id,role) VALUES($1,$2,$3)',
      [id, org, role],
    );
    actors[key] = await actor(`${key}@catus.test`);
  }
});
afterAll(async () => {
  await pool.query(
    'TRUNCATE rate_limits,idempotency_keys,audit_events,sessions,oidc_transactions,requests,interactions,projects,clients,memberships,users,organizations CASCADE',
  );
  await pool.end();
});
describe('M1: authentication and session security', () => {
  test('fails closed without OIDC; legacy bearer and forged identities are rejected', async () => {
    const disabled = createApp({ origin: config.origin, secureCookies: false });
    expect(
      (await disabled(new Request(`${config.origin}/api/auth/login`))).status,
    ).toBe(503);
    expect(
      (await disabled(new Request(`${config.origin}/api/auth/config`))).status,
    ).toBe(200);
    expect(
      (
        await disabled(
          new Request(`${config.origin}/api/session`, {
            headers: { Cookie: actors.po!.cookie },
          }),
        )
      ).status,
    ).toBe(503);
    for (const path of [
      'session',
      'health',
      'mission-control',
      'members',
      'audit',
      'extraction',
    ])
      expect(
        (
          await call(undefined, path, 'GET', undefined, {
            Authorization: 'Bearer old-dev-token',
            'X-User-Id': ids.admin!,
            'X-Role': 'administrator',
          })
        ).status,
      ).toBe(401);
    expect(
      (await call(undefined, 'clients', 'POST', { name: 'forged' })).status,
    ).toBe(401);
  });
  test('uses PKCE, nonce, state, HTTP-only cookies and consumes callback once', async () => {
    const start = await call(undefined, 'auth/login');
    const auth = new URL(start.headers.get('location')!);
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
    expect(auth.searchParams.get('nonce')).toBeTruthy();
    expect(start.headers.getSetCookie()[0]).toContain('HttpOnly');
    expect(start.headers.getSetCookie()[0]).toContain('SameSite=Lax');
    const state = auth.searchParams.get('state')!,
      cookie = start.headers.getSetCookie()[0]!.split(';')[0]!;
    const url = `auth/callback?state=${state}&code=${codeFor(auth, 'po@catus.test')}`;
    expect((await call(undefined, url)).status).toBe(401);
    expect(
      (await call(undefined, url, 'GET', undefined, { Cookie: cookie })).status,
    ).toBe(303);
    expect(
      (await call(undefined, url, 'GET', undefined, { Cookie: cookie })).status,
    ).toBe(401);
  });
  test('rejects invalid signature, nonce, audience, issuer, expiry, email and Workspace domain', async () => {
    for (const failure of [
      'signature',
      'nonce',
      'audience',
      'issuer',
      'expired',
      'email',
      'domain',
    ] as const) {
      const { result } = await login('po@catus.test', failure);
      expect({ failure, status: result.status }).toEqual({
        failure,
        status: 401,
      });
    }
    expect((await login('uninvited@catus.test')).result.status).toBe(403);
    expect((await login('po@catus.test', 'subject')).result.status).toBe(403);
  });
  test('rejects bad state, expired state and wrong PKCE verifier', async () => {
    const start = await call(undefined, 'auth/login');
    const auth = new URL(start.headers.get('location')!);
    const state = auth.searchParams.get('state')!;
    const cookie = start.headers.getSetCookie()[0]!.split(';')[0]!;
    expect(
      (
        await call(
          undefined,
          `auth/callback?state=forged&code=x`,
          'GET',
          undefined,
          { Cookie: cookie },
        )
      ).status,
    ).toBe(401);
    await pool.query(
      'UPDATE oidc_transactions SET verifier=$2 WHERE state_hash=$1',
      [hash(state), 'invalid-verifier'],
    );
    expect(
      (
        await call(
          undefined,
          `auth/callback?state=${state}&code=${codeFor(auth, 'po@catus.test')}`,
          'GET',
          undefined,
          { Cookie: cookie },
        )
      ).status,
    ).toBe(401);
    const second = await call(undefined, 'auth/login');
    const a2 = new URL(second.headers.get('location')!);
    const s2 = a2.searchParams.get('state')!;
    await pool.query(
      "UPDATE oidc_transactions SET expires_at=now()-interval '1 minute' WHERE state_hash=$1",
      [hash(s2)],
    );
    expect(
      (
        await call(
          undefined,
          `auth/callback?state=${s2}&code=x`,
          'GET',
          undefined,
          { Cookie: second.headers.getSetCookie()[0]!.split(';')[0]! },
        )
      ).status,
    ).toBe(401);
  });
  test('enforces CSRF and exact origin; refuses invalid JSON/type/size and identity payloads', async () => {
    const po = actors.po!;
    expect(
      (await call(po, 'clients', 'POST', { name: 'X' }, { 'X-CSRF-Token': '' }))
        .status,
    ).toBe(403);
    expect(
      (
        await call(
          po,
          'clients',
          'POST',
          { name: 'X' },
          { Origin: 'https://evil.test' },
        )
      ).status,
    ).toBe(403);
    expect(
      (await call(po, 'clients', 'POST', { name: 'X' }, { Origin: '' })).status,
    ).toBe(403);
    expect((await call(po, 'clients', 'POST', { name: '  ' })).status).toBe(
      422,
    );
    expect((await call(po, 'clients', 'POST', [])).status).toBe(422);
    expect(
      (
        await call(
          po,
          'clients',
          'POST',
          { name: 'X' },
          { 'Content-Type': 'text/plain' },
        )
      ).status,
    ).toBe(415);
    expect(
      (await call(po, 'clients', 'POST', { name: 'x'.repeat(40000) })).status,
    ).toBe(413);
    for (const body of [
      { name: 'X', organization_id: orgB },
      { name: 'X', actor: ids.admin },
      { name: 'X', role: 'administrator' },
    ])
      expect((await call(po, 'clients', 'POST', body)).status).toBe(422);
    expect(
      (
        await app(
          new Request(config.origin + '/api/clients', {
            method: 'POST',
            headers: {
              Cookie: po.cookie,
              'X-CSRF-Token': po.csrf,
              Origin: config.origin,
              'Content-Type': 'application/json',
              'Idempotency-Key': crypto.randomUUID(),
            },
            body: '{',
          }),
        )
      ).status,
    ).toBe(422);
  });
  test('stores only session digest; expires, logs out, revokes all and denies duplicate cookies', async () => {
    const a = await actor('po@catus.test');
    const raw = a.cookie.split('=')[1]!;
    expect(
      (await pool.query('SELECT 1 FROM sessions WHERE token_hash=$1', [raw]))
        .rowCount,
    ).toBe(0);
    const row = (
      await pool.query('SELECT id FROM sessions WHERE token_hash=$1', [
        hash(raw),
      ])
    ).rows[0];
    expect(row).toBeTruthy();
    await pool.query(
      "UPDATE sessions SET last_seen_at=now()-interval '31 minutes' WHERE id=$1",
      [row.id],
    );
    expect((await call(a, 'session')).status).toBe(401);
    const b = await actor('po@catus.test');
    await pool.query(
      "UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1",
      [hash(b.cookie.split('=')[1]!)],
    );
    expect((await call(b, 'session')).status).toBe(401);
    const c = await actor('po@catus.test');
    expect((await call(c, 'session/logout', 'POST', {})).status).toBe(200);
    expect((await call(c, 'session')).status).toBe(401);
    const d = await actor('manager@catus.test'),
      e = await actor('manager@catus.test');
    expect((await call(d, 'session/revoke-all', 'POST', {})).status).toBe(200);
    expect((await call(e, 'session')).status).toBe(401);
    actors.manager = await actor('manager@catus.test');
    expect(
      (
        await call(actors.po!, 'session', 'GET', undefined, {
          Cookie: `${actors.po!.cookie}; ${actors.po!.cookie}`,
        })
      ).status,
    ).toBe(401);
  });
});
describe('M0 regression with two roles and tenant authorization', () => {
  test('PO creates complete persisted M0 workflow with audit, invalid transitions and concurrent writes', async () => {
    const po = actors.po!;
    const c = await create(po, 'clients', {
      name: "Cliente '); DROP TABLE clients; --",
    });
    expect(c.name).toContain('DROP TABLE');
    const p = await create(po, 'projects', {
      client_id: c.id,
      name: 'Loja teste',
    });
    expect(
      (
        await call(po, 'projects', 'POST', {
          client_id: crypto.randomUUID(),
          name: 'Invalid',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call(po, 'interactions', 'POST', {
          project_id: p.id,
          kind: 'meeting',
          summary: 'x',
          occurred_at: 'yesterday',
        })
      ).status,
    ).toBe(422);
    const i = await create(po, 'interactions', {
      project_id: p.id,
      kind: 'meeting',
      summary: 'Melhorar checkout',
      occurred_at: '2026-10-31T10:00:00-03:00',
    });
    interactionId = i.id;
    const r = await create(po, 'requests', {
      interaction_id: i.id,
      title: 'Checkout',
      description: 'Documentar requisitos',
      owner_user_id: ids.dev,
      next_action: 'Confirmar escopo',
    });
    requestId = r.id;
    expect(r.status).toBe('new');
    const board = await (await call(po, 'mission-control')).json();
    expect(
      board.requests.find((x: { id: string }) => x.id === r.id),
    ).toMatchObject({
      client_name: c.name,
      project_name: p.name,
      project_id: p.id,
      owner: 'dev',
      owner_user_id: ids.dev,
      next_action: 'Confirmar escopo',
      status: 'new',
    });
    const patch = {
      status: 'done',
      owner_user_id: ids.dev,
      next_action: 'Revisar',
      version: 1,
    };
    expect((await call(po, `requests/${r.id}`, 'PATCH', patch)).status).toBe(
      422,
    );
    expect(
      (
        await pool.query(
          'SELECT count(*)::int n FROM audit_events WHERE request_id=$1',
          [r.id],
        )
      ).rows[0].n,
    ).toBe(1);
    const responses = await Promise.all([
      call(po, `requests/${r.id}`, 'PATCH', { ...patch, status: 'triage' }),
      call(po, `requests/${r.id}`, 'PATCH', { ...patch, status: 'triage' }),
    ]);
    expect(responses.map((x) => x.status).sort()).toEqual([200, 409]);
    expect(
      (
        await call(po, `requests/${r.id}`, 'PATCH', {
          ...patch,
          status: 'ready',
          version: 2,
        })
      ).status,
    ).toBe(200);
    for (const type of ['client', 'project', 'interaction', 'request'])
      expect(
        (
          await pool.query(
            'SELECT 1 FROM audit_events WHERE organization_id=$1 AND actor_user_id=$2 AND entity_type=$3',
            [orgA, ids.po, type],
          )
        ).rowCount,
      ).toBeGreaterThan(0);
    expect(await (await call(po, 'extraction')).json()).toMatchObject({
      available: false,
    });
  });
  test('developer can execute own assigned request, but cannot create, reassign or manage roles', async () => {
    const dev = actors.dev!;
    for (const path of [
      'clients',
      'projects',
      'interactions',
      'requests',
      'memberships',
    ])
      expect((await call(dev, path, 'POST', { name: 'Denied' })).status).toBe(
        403,
      );
    expect((await call(dev, 'audit')).status).toBe(403);
    expect((await call(actors.po!, 'audit')).status).toBe(403);
    expect((await call(actors.manager!, 'audit')).status).toBe(200);
    expect(
      (
        await call(dev, `requests/${requestId}`, 'PATCH', {
          status: 'in_progress',
          owner_user_id: ids.po,
          next_action: 'X',
          version: 3,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(dev, `requests/${requestId}`, 'PATCH', {
          status: 'in_progress',
          owner_user_id: ids.dev,
          next_action: 'Implementar',
          version: 3,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(dev, `requests/${requestId}`, 'PATCH', {
          status: 'done',
          owner_user_id: ids.dev,
          next_action: 'Revisão humana',
          version: 4,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await pool.query(
          'SELECT actor_user_id FROM audit_events WHERE request_id=$1 ORDER BY id DESC LIMIT 1',
          [requestId],
        )
      ).rows[0].actor_user_id,
    ).toBe(ids.dev);
    const own = await create(actors.po!, 'requests', {
      interaction_id: interactionId,
      title: 'Atribuída ao PO',
      description: 'x',
      owner_user_id: ids.po,
      next_action: 'x',
    });
    expect(
      (
        await call(dev, `requests/${own.id}`, 'PATCH', {
          status: 'triage',
          owner_user_id: ids.dev,
          next_action: 'x',
          version: 1,
        })
      ).status,
    ).toBe(403);
  });
  test('isolates all reads, guessed relationships, assignments, updates and organization switching', async () => {
    const other = actors.other!,
      po = actors.po!;
    const b = await create(other, 'clients', { name: 'Only B' });
    const p = await create(other, 'projects', {
      client_id: b.id,
      name: 'B project',
    });
    const i = await create(other, 'interactions', {
      project_id: p.id,
      kind: 'service',
      summary: 'B context',
      occurred_at: '2026-10-31T10:00:00Z',
    });
    const r = await create(other, 'requests', {
      interaction_id: i.id,
      title: 'Only B request',
      description: 'B',
      owner_user_id: ids.other,
      next_action: 'B action',
    });
    const board = await (await call(po, 'mission-control')).json();
    expect(JSON.stringify(board)).not.toContain('Only B');
    const members = await (await call(po, 'members')).json();
    expect(members.some((u: { id: string }) => u.id === ids.other)).toBe(false);
    expect(
      (await call(po, 'projects', 'POST', { client_id: b.id, name: 'Attack' }))
        .status,
    ).toBe(404);
    expect(
      (
        await call(po, 'interactions', 'POST', {
          project_id: p.id,
          kind: 'meeting',
          summary: 'Attack',
          occurred_at: '2026-10-31T10:00:00Z',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call(po, 'requests', 'POST', {
          interaction_id: i.id,
          title: 'Attack',
          description: 'x',
          owner_user_id: ids.po,
          next_action: 'x',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call(po, 'requests', 'POST', {
          interaction_id: interactionId,
          title: 'Attack',
          description: 'x',
          owner_user_id: ids.other,
          next_action: 'x',
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await call(po, `requests/${r.id}`, 'PATCH', {
          status: 'triage',
          owner_user_id: ids.po,
          next_action: 'Attack',
          version: 1,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call(po, 'session/organization', 'POST', {
          organization_id: orgB,
        })
      ).status,
    ).toBe(403);
    const audit = await (await call(actors.admin!, 'audit')).json();
    expect(audit.some((e: { entity_id: string }) => e.entity_id === r.id)).toBe(
      false,
    );
    const conn = await pool.connect();
    try {
      await conn.query('BEGIN');
      await expect(
        conn.query(
          'INSERT INTO projects(id,organization_id,client_id,name) VALUES($1,$2,$3,$4)',
          [crypto.randomUUID(), orgA, b.id, 'Invalid DB link'],
        ),
      ).rejects.toMatchObject({ code: '23503' });
      await conn.query('ROLLBACK');
    } finally {
      conn.release();
    }
  });
  test('authorized organization switching rotates session and CSRF without expanding memberships', async () => {
    const id = crypto.randomUUID();
    await pool.query(
      'INSERT INTO users(id,issuer,email,display_name) VALUES($1,$2,$3,$4)',
      [id, config.oidc!.issuer, 'multi@catus.test', 'Multi'],
    );
    await pool.query(
      "INSERT INTO memberships(user_id,organization_id,role) VALUES($1,$2,'po'),($1,$3,'developer')",
      [id, orgA, orgB],
    );
    const a = await actor('multi@catus.test');
    const initial = (await (await call(a, 'session')).json()) as SessionView;
    const target = initial.organization.id === orgA ? orgB : orgA;
    const changed = await call(a, 'session/organization', 'POST', {
      organization_id: target,
    });
    expect(changed.status).toBe(200);
    expect((await call(a, 'session')).status).toBe(401);
    const nextCookie = changed.headers.getSetCookie()[0]!.split(';')[0]!;
    expect(nextCookie).not.toBe(a.cookie);
    const next = (await (
      await call({ cookie: nextCookie, csrf: '', id }, 'session')
    ).json()) as SessionView;
    expect(next.organization.id).toBe(target);
    expect(next.role).toBe(target === orgA ? 'po' : 'developer');
    expect(next.csrfToken).not.toBe(a.csrf);
    expect(
      (
        await call(
          { cookie: nextCookie, csrf: a.csrf, id },
          'clients',
          'POST',
          { name: 'CSRF from old org' },
        )
      ).status,
    ).toBe(403);
  });
  test('legacy text owners require explicit user binding and inactive identities lose access', async () => {
    const id = crypto.randomUUID();
    await pool.query(
      "INSERT INTO requests(id,organization_id,interaction_id,title,description,status,owner,next_action) VALUES($1,$2,$3,'Legacy request','Keep description','new','Original textual owner','Confirm')",
      [id, orgA, interactionId],
    );
    const board = await (await call(actors.po!, 'mission-control')).json();
    expect(
      board.requests.find((r: { id: string }) => r.id === id),
    ).toMatchObject({ owner: 'Original textual owner', owner_user_id: null });
    expect(
      (
        await call(actors.po!, `requests/${id}`, 'PATCH', {
          status: 'triage',
          owner_user_id: ids.po,
          next_action: 'Explicitly linked',
          version: 1,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await pool.query(
          'SELECT owner_user_id,description FROM requests WHERE id=$1',
          [id],
        )
      ).rows[0],
    ).toMatchObject({ owner_user_id: ids.po, description: 'Keep description' });
    expect(
      (await pool.query('SELECT owner FROM requests WHERE id=$1', [id])).rows[0]
        .owner,
    ).toBe('Original textual owner');
    await pool.query('UPDATE users SET active=false WHERE id=$1', [
      ids.manager,
    ]);
    expect((await call(actors.manager!, 'session')).status).toBe(401);
    await pool.query('UPDATE users SET active=true WHERE id=$1', [ids.manager]);
  });
  test('admin provisions users without self escalation; role changes and revocation take effect immediately', async () => {
    expect(
      (
        await call(actors.po!, 'memberships', 'POST', {
          email: 'po@catus.test',
          name: 'PO',
          role: 'administrator',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(actors.admin!, 'memberships', 'POST', {
          email: 'admin@catus.test',
          name: 'Admin',
          role: 'developer',
        })
      ).status,
    ).toBe(403);
    expect(
      (await call(actors.admin!, `memberships/${ids.admin}/revoke`, 'POST', {}))
        .status,
    ).toBe(403);
    expect(
      (
        await call(actors.admin!, 'memberships', 'POST', {
          email: 'new@catus.test',
          name: 'New',
          role: 'manager',
        })
      ).status,
    ).toBe(201);
    const added = await actor('new@catus.test');
    expect((await call(added, 'audit')).status).toBe(200);
    expect(
      (
        await call(actors.admin!, 'memberships', 'POST', {
          email: 'new@catus.test',
          name: 'New',
          role: 'developer',
        })
      ).status,
    ).toBe(201);
    expect((await call(added, 'audit')).status).toBe(403);
    expect(
      (await call(actors.admin!, `memberships/${added.id}/revoke`, 'POST', {}))
        .status,
    ).toBe(200);
    expect((await call(added, 'session')).status).toBe(401);
    expect((await login('new@catus.test')).result.status).toBe(403);
    expect(
      (await call(actors.admin!, `memberships/${ids.other}/revoke`, 'POST', {}))
        .status,
    ).toBe(404);
  });
});
test('incremental migration preserves M0 records, owner text, audit history and constraints', async () => {
  const c = await pool.connect();
  const schema = `migration_${crypto.randomUUID().replaceAll('-', '')}`;
  try {
    await c.query(`CREATE SCHEMA ${schema}`);
    await c.query(`SET search_path TO ${schema}`);
    await c.query(await readFile('db/migrations/001_initial.sql', 'utf8'));
    const [a, p, i, r] = Array.from({ length: 4 }, () => crypto.randomUUID());
    await c.query('INSERT INTO clients(id,name) VALUES($1,$2)', [
      a,
      'Legacy client',
    ]);
    await c.query('INSERT INTO projects(id,client_id,name) VALUES($1,$2,$3)', [
      p,
      a,
      'Legacy project',
    ]);
    await c.query(
      "INSERT INTO interactions(id,project_id,kind,summary,occurred_at) VALUES($1,$2,'meeting','Legacy context',now())",
      [i, p],
    );
    await c.query(
      "INSERT INTO requests(id,interaction_id,title,description,status,owner,next_action) VALUES($1,$2,'Legacy title','Legacy description','new','Unresolved PO','Confirm')",
      [r, i],
    );
    await c.query(
      "INSERT INTO audit_events(request_id,actor,action) VALUES($1,'local-developer','created')",
      [r],
    );
    await c.query(await readFile('db/migrations/002_identity.sql', 'utf8'));
    expect(
      (
        await c.query(
          'SELECT owner,owner_user_id,organization_id FROM requests WHERE id=$1',
          [r],
        )
      ).rows[0],
    ).toMatchObject({
      owner: 'Unresolved PO',
      owner_user_id: null,
      organization_id: '00000000-0000-4000-8000-000000000001',
    });
    expect(
      (
        await c.query(
          'SELECT actor,actor_user_id FROM audit_events WHERE request_id=$1',
          [r],
        )
      ).rows[0],
    ).toMatchObject({ actor: 'local-developer', actor_user_id: null });
    expect(
      (await c.query('SELECT name FROM clients WHERE id=$1', [a])).rows[0].name,
    ).toBe('Legacy client');
  } finally {
    await c.query('SET search_path TO public');
    await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    c.release();
  }
});
