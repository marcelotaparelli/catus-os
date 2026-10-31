import { afterAll, describe, expect, test } from 'bun:test';
import { createApp } from '../src/server/app';
import { pool } from '../src/server/db';
const token = 'test-only-token-that-is-at-least-32-characters';
const app = createApp(token);
const clients: string[] = [];
async function call(
  path: string,
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return app(
    new Request(`http://localhost/api/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
async function create(path: string, body: unknown) {
  const r = await call(path, 'POST', body);
  expect(r.status).toBe(201);
  return await r.json();
}
afterAll(async () => {
  for (const id of clients) {
    await pool.query(
      'DELETE FROM audit_events WHERE request_id IN (SELECT r.id FROM requests r JOIN interactions i ON i.id=r.interaction_id JOIN projects p ON p.id=i.project_id WHERE p.client_id=$1)',
      [id],
    );
    await pool.query(
      'DELETE FROM requests WHERE interaction_id IN (SELECT i.id FROM interactions i JOIN projects p ON p.id=i.project_id WHERE p.client_id=$1)',
      [id],
    );
    await pool.query(
      'DELETE FROM interactions WHERE project_id IN (SELECT id FROM projects WHERE client_id=$1)',
      [id],
    );
    await pool.query('DELETE FROM projects WHERE client_id=$1', [id]);
    await pool.query('DELETE FROM clients WHERE id=$1', [id]);
  }
  await pool.end();
});
describe('real PostgreSQL API', () => {
  test('rejects missing authentication, hostile origin and malformed inputs', async () => {
    expect(
      (await app(new Request('http://localhost/api/mission-control'))).status,
    ).toBe(401);
    expect(
      (
        await call(
          'clients',
          'POST',
          { name: 'X' },
          { Origin: 'https://evil.example' },
        )
      ).status,
    ).toBe(403);
    expect((await call('clients', 'POST', { name: '  ' })).status).toBe(422);
    expect((await call('clients', 'POST', [])).status).toBe(422);
    expect(
      (
        await call(
          'clients',
          'POST',
          { name: 'x' },
          { 'Content-Type': 'text/plain' },
        )
      ).status,
    ).toBe(415);
    expect(
      (await call('clients', 'POST', { name: 'x'.repeat(40000) })).status,
    ).toBe(413);
    expect(
      (
        await app(
          new Request('http://localhost/api/clients', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: '{',
          }),
        )
      ).status,
    ).toBe(422);
  });
  test('persists full workflow, enforces rules and detects concurrent updates', async () => {
    const c = await create('clients', {
      name: `API test ${crypto.randomUUID()}`,
    });
    clients.push(c.id);
    const p = await create('projects', { client_id: c.id, name: 'Loja teste' });
    expect(
      (
        await call('projects', 'POST', {
          client_id: crypto.randomUUID(),
          name: 'Invalid',
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await call('interactions', 'POST', {
          project_id: p.id,
          kind: 'meeting',
          summary: 'x',
          occurred_at: 'yesterday',
        })
      ).status,
    ).toBe(422);
    const i = await create('interactions', {
      project_id: p.id,
      kind: 'meeting',
      summary: 'Cliente solicita melhoria no checkout',
      occurred_at: '2026-10-31T10:00:00-03:00',
    });
    const r = await create('requests', {
      interaction_id: i.id,
      title: 'Revisar checkout',
      description: 'Documentar requisitos',
      owner: 'PO Teste',
      next_action: 'Confirmar escopo',
    });
    expect(r.status).toBe('new');
    const board = await (await call('mission-control')).json();
    const item = board.requests.find((x: { id: string }) => x.id === r.id);
    expect(item).toMatchObject({
      client_name: c.name,
      project_name: p.name,
      owner: 'PO Teste',
      next_action: 'Confirmar escopo',
      status: 'new',
    });
    const patch = {
      status: 'done',
      owner: 'PO Teste',
      next_action: 'Revisar',
      version: 1,
    };
    expect((await call(`requests/${r.id}`, 'PATCH', patch)).status).toBe(422);
    expect(
      (
        await pool.query(
          'SELECT count(*)::int n FROM audit_events WHERE request_id=$1',
          [r.id],
        )
      ).rows[0].n,
    ).toBe(1);
    const responses = await Promise.all([
      call(`requests/${r.id}`, 'PATCH', { ...patch, status: 'triage' }),
      call(`requests/${r.id}`, 'PATCH', { ...patch, status: 'triage' }),
    ]);
    expect(responses.map((x) => x.status).sort()).toEqual([200, 409]);
    expect(
      (
        await pool.query(
          'SELECT count(*)::int n FROM audit_events WHERE request_id=$1',
          [r.id],
        )
      ).rows[0].n,
    ).toBe(2);
    expect((await call('extraction')).status).toBe(200);
    expect(await (await call('extraction')).json()).toMatchObject({
      available: false,
    });
  });
  test('SQL injection input is stored as plain data', async () => {
    const name = "Cliente '); DROP TABLE clients; --";
    const c = await create('clients', { name });
    clients.push(c.id);
    expect(c.name).toBe(name);
    expect(
      (await pool.query('SELECT name FROM clients WHERE id=$1', [c.id])).rows[0]
        .name,
    ).toBe(name);
  });
});
