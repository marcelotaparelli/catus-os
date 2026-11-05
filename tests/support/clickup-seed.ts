// Test harness only. Goes through the real sync with a stubbed provider, so the browser
// journey sees what the worker would have stored. All names and ids are invented.
import type { Pool } from 'pg';
import { createClickUpClient } from '../../src/server/clickup/client';
import { runDueSyncs } from '../../src/server/clickup/sync';

const WORKSPACE = '1234567';
const day = 86400000;
function task(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: 'Tarefa sintética ' + id,
    team_id: WORKSPACE,
    url: 'https://app.clickup.com/t/' + id,
    status: { status: 'em andamento', type: 'custom' },
    date_created: '1767225600000',
    date_updated: '1767225600000',
    assignees: [{ id: 1, username: 'Pessoa Um' }],
    dependencies: [],
    parent: null,
    due_date: null,
    due_date_time: false,
    ...extra,
  };
}
export async function seedClickup(pool: Pool, organizationId: string) {
  const creator = (
    await pool.query(
      "SELECT user_id FROM memberships WHERE organization_id=$1 AND role='manager' LIMIT 1",
      [organizationId],
    )
  ).rows[0].user_id;
  const client = (
    await pool.query(
      "INSERT INTO clients(id,organization_id,name) VALUES(gen_random_uuid(),$1,'Cliente Sintético') RETURNING id",
      [organizationId],
    )
  ).rows[0].id;
  const project = async (name: string, listId?: string) => {
    const id = (
      await pool.query(
        'INSERT INTO projects(id,organization_id,client_id,name) VALUES(gen_random_uuid(),$1,$2,$3) RETURNING id',
        [organizationId, client, name],
      )
    ).rows[0].id;
    if (listId)
      await pool.query(
        'INSERT INTO clickup_project_links(organization_id,project_id,list_id,created_by) VALUES($1,$2,$3,$4)',
        [organizationId, id, listId, creator],
      );
    return id;
  };
  await project('CU Atualizado', '9001');
  await project('CU Falhou', '9002');
  await project('CU Nunca lido', '9003');
  await project('CU Antigo', '9004');
  await project('CU Sem vínculo');
  const now = Date.now();
  const lists: Record<string, unknown[]> = {
    '9001': [
      task('a1', {
        name: 'Tarefa sintética atrasada',
        due_date: String(now - 3 * day),
        due_date_time: true,
      }),
      task('a2', {
        status: { status: 'Travado por Terceiro', type: 'custom' },
        assignees: [{ id: 2, username: 'Pessoa Dois' }],
        due_date: String(now + 5 * day),
        due_date_time: true,
      }),
      task('a3', { assignees: [] }),
      task('a4', { status: { status: 'Entregue', type: 'closed' } }),
      task('a5', { parent: 'a1' }),
    ],
    '9002': [task('b1'), task('b2')],
    '9004': [task('d1')],
  };
  let down = new Set<string>(['9003']);
  const reader = createClickUpClient({
    token: 'synthetic',
    requestsPerMinute: 600000,
    fetch: (async (input: URL) => {
      const m = /\/list\/(\d+)(\/task)?$/.exec(new URL(input).pathname)!;
      if (down.has(m[1]!)) return new Response('', { status: 500 });
      if (!m[2])
        return Response.json({ id: m[1], name: 'Lista sintética ' + m[1] });
      return Response.json({ tasks: lists[m[1]!] ?? [], last_page: true });
    }) as unknown as typeof fetch,
  });
  const options = {
    organizationId,
    workspaceId: WORKSPACE,
    syncMinutes: 15,
  };
  await runDueSyncs(pool, reader, options);
  // The second read fails: its project keeps the numbers of the first.
  down = new Set(['9002', '9003']);
  await pool.query(
    "UPDATE clickup_project_links SET next_sync_at=now() WHERE organization_id=$1 AND list_id='9002'",
    [organizationId],
  );
  await runDueSyncs(pool, reader, options);
  await pool.query(
    "UPDATE clickup_project_links SET last_success_at=now()-interval '6 hours' WHERE organization_id=$1 AND list_id='9004'",
    [organizationId],
  );
  // Nothing else runs in the journey.
  await pool.query(
    "UPDATE clickup_project_links SET next_sync_at=now()+interval '1 day' WHERE organization_id=$1",
    [organizationId],
  );
}
