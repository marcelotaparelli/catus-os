// Reads a whole list first and only then writes, in one transaction. So a failure or a 429
// on any page leaves the previous picture untouched, and absence is only ever concluded
// from a read that reached its last page. No transaction stays open during HTTP.
import type { Pool, PoolClient } from 'pg';
import { ClickUpError } from './client';
import type { ClickUpClient } from './client';
import { parseListName, parseTaskPage } from './parse';
import type { ParsedTask } from './parse';

export const MAX_PAGES = 200;
const LEASE_SECONDS = 600,
  MAX_BACKOFF_MINUTES = 360;
export interface SyncOptions {
  organizationId: string;
  workspaceId: string;
  syncMinutes: number;
}
interface Claim {
  run_id: string;
  link_id: string;
  list_id: string;
}
/** Takes the next due list, at most one run per link across processes. */
export async function claimDueLink(pool: Pool, organizationId: string) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query(
      "UPDATE clickup_sync_runs SET state='failed',finished_at=now(),error_code='lease_expired' WHERE organization_id=$1 AND state='running' AND lease_until<now()",
      [organizationId],
    );
    const { rows } = await db.query<Claim>(
      `WITH due AS (
  SELECT id,list_id FROM clickup_project_links l WHERE organization_id=$1 AND active AND next_sync_at<=now()
  AND NOT EXISTS(SELECT 1 FROM clickup_sync_runs r WHERE r.link_id=l.id AND r.state='running')
  ORDER BY next_sync_at LIMIT 1 FOR UPDATE SKIP LOCKED)
 INSERT INTO clickup_sync_runs(organization_id,link_id,list_id,lease_until)
 SELECT $1,id,list_id,now()+make_interval(secs=>$2) FROM due
 ON CONFLICT DO NOTHING RETURNING id run_id,link_id,list_id`,
      [organizationId, LEASE_SECONDS],
    );
    await db.query('COMMIT');
    return rows[0] ?? null;
  } catch (e) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    db.release();
  }
}
/** A task repeated across pages counts once; the first answer wins within one read. */
async function readWholeList(
  client: ClickUpClient,
  listId: string,
  workspaceId: string,
) {
  const warnings = { count: 0 },
    tasks = new Map<string, ParsedTask>();
  const listName = parseListName(await client.getList(listId));
  let pages = 0;
  for (;;) {
    if (pages >= MAX_PAGES) throw new ClickUpError('too_many_pages');
    const page = parseTaskPage(
      await client.getTasksPage(listId, pages),
      workspaceId,
      warnings,
    );
    pages++;
    for (const t of page.tasks) if (!tasks.has(t.id)) tasks.set(t.id, t);
    if (page.finished) break;
  }
  return {
    listName,
    pages,
    tasks: [...tasks.values()],
    warnings: warnings.count,
  };
}
async function applyRead(
  db: PoolClient,
  claim: Claim,
  options: SyncOptions,
  read: Awaited<ReturnType<typeof readWholeList>>,
  httpCalls: number,
) {
  const org = options.organizationId;
  const current = (
    await db.query(
      'SELECT active FROM clickup_project_links WHERE id=$1 AND organization_id=$2 FOR UPDATE',
      [claim.link_id, org],
    )
  ).rows[0];
  if (!current?.active) return { stale: true as const };
  const people = new Map<string, string>();
  for (const t of read.tasks)
    for (const p of t.assignees) if (p.name) people.set(p.id, p.name);
  await db.query(
    `INSERT INTO clickup_people(organization_id,clickup_user_id,display_name)
 SELECT $1,i,n FROM unnest($2::text[],$3::text[]) AS t(i,n)
 ON CONFLICT(organization_id,clickup_user_id) DO UPDATE SET display_name=excluded.display_name,updated_at=now()
 WHERE clickup_people.display_name IS DISTINCT FROM excluded.display_name`,
    [org, [...people.keys()], [...people.values()]],
  );
  // Same stored content is not rewritten, and an older answer never replaces a newer one
  // (a task in two lists is read twice, at different moments).
  const written = await db.query<{ inserted: boolean }>(
    `INSERT INTO clickup_tasks AS c(organization_id,task_id,name,url,parent_task_id,status_raw,status_type,assignee_ids,waiting_on,due_at,due_has_time,start_at,closed_at,source_created_at,source_updated_at)
 SELECT $1,x.id,x.name,x.url,x.parent,x.status,x."statusType",ARRAY(SELECT jsonb_array_elements(x.assignees)->>'id'),
  CASE WHEN x."waitingOn" IS NULL OR x."waitingOn"='null'::jsonb THEN NULL ELSE ARRAY(SELECT jsonb_array_elements_text(x."waitingOn")) END,
  x."dueAt",x."dueHasTime",x."startAt",x."closedAt",x."createdAt",x."updatedAt"
 FROM jsonb_to_recordset($2::jsonb) AS x(id text,name text,url text,parent text,status text,"statusType" text,assignees jsonb,"waitingOn" jsonb,"dueAt" timestamptz,"dueHasTime" boolean,"startAt" timestamptz,"closedAt" timestamptz,"createdAt" timestamptz,"updatedAt" timestamptz)
 ON CONFLICT(organization_id,task_id) DO UPDATE SET name=excluded.name,url=excluded.url,parent_task_id=excluded.parent_task_id,status_raw=excluded.status_raw,status_type=excluded.status_type,assignee_ids=excluded.assignee_ids,waiting_on=excluded.waiting_on,due_at=excluded.due_at,due_has_time=excluded.due_has_time,start_at=excluded.start_at,closed_at=excluded.closed_at,source_created_at=excluded.source_created_at,source_updated_at=excluded.source_updated_at,synced_at=now()
 WHERE (c.source_updated_at IS NULL OR excluded.source_updated_at IS NULL OR excluded.source_updated_at>=c.source_updated_at)
 AND (c.name,c.url,c.parent_task_id,c.status_raw,c.status_type,c.assignee_ids,c.waiting_on,c.due_at,c.due_has_time,c.start_at,c.closed_at,c.source_updated_at)
 IS DISTINCT FROM (excluded.name,excluded.url,excluded.parent_task_id,excluded.status_raw,excluded.status_type,excluded.assignee_ids,excluded.waiting_on,excluded.due_at,excluded.due_has_time,excluded.start_at,excluded.closed_at,excluded.source_updated_at)
 RETURNING (xmax=0) inserted`,
    [org, JSON.stringify(read.tasks)],
  );
  const ids = read.tasks.map((t) => t.id);
  await db.query(
    `INSERT INTO clickup_list_tasks(organization_id,link_id,task_id,last_seen_run_id)
 SELECT $1,$2,i,$3 FROM unnest($4::text[]) AS i
 ON CONFLICT(link_id,task_id) DO UPDATE SET last_seen_run_id=excluded.last_seen_run_id,missing_since=NULL`,
    [org, claim.link_id, claim.run_id, ids],
  );
  const missing = await db.query(
    'UPDATE clickup_list_tasks SET missing_since=now() WHERE link_id=$1 AND organization_id=$2 AND last_seen_run_id<>$3 AND missing_since IS NULL',
    [claim.link_id, org, claim.run_id],
  );
  const inserted = written.rows.filter((r) => r.inserted).length;
  await db.query(
    `UPDATE clickup_sync_runs SET state='succeeded',finished_at=now(),http_calls=$2,pages=$3,tasks_seen=$4,tasks_inserted=$5,tasks_updated=$6,tasks_missing=$7,data_warnings=$8 WHERE id=$1`,
    [
      claim.run_id,
      httpCalls,
      read.pages,
      ids.length,
      inserted,
      written.rows.length - inserted,
      missing.rowCount,
      read.warnings,
    ],
  );
  await db.query(
    `UPDATE clickup_project_links SET list_name=$2,last_attempt_at=now(),last_success_at=now(),last_error_code=NULL,last_data_warnings=$3,consecutive_failures=0,next_sync_at=now()+make_interval(mins=>$4) WHERE id=$1`,
    [claim.link_id, read.listName, read.warnings, options.syncMinutes],
  );
  return { stale: false as const };
}
async function recordFailure(
  pool: Pool,
  claim: Claim,
  options: SyncOptions,
  code: string,
  httpStatus: number | null,
  retryAfter: number | null,
  httpCalls: number,
) {
  await pool.query(
    "UPDATE clickup_sync_runs SET state='failed',finished_at=now(),error_code=$2,http_status=$3,http_calls=$4 WHERE id=$1",
    [claim.run_id, code, httpStatus, httpCalls],
  );
  // Doubles per failure up to 6h, and never earlier than the provider asked.
  await pool.query(
    `UPDATE clickup_project_links SET last_attempt_at=now(),last_error_code=$2,consecutive_failures=consecutive_failures+1,
 next_sync_at=now()+GREATEST(make_interval(mins=>LEAST($3,$4*power(2,LEAST(consecutive_failures,10))::int)),make_interval(secs=>$5)) WHERE id=$1`,
    [
      claim.link_id,
      code,
      MAX_BACKOFF_MINUTES,
      options.syncMinutes,
      retryAfter ?? 0,
    ],
  );
}
/** One list, start to finish. Returns seconds to pause when the token hit its limit. */
export async function syncClaimed(
  pool: Pool,
  client: ClickUpClient,
  claim: Claim,
  options: SyncOptions,
) {
  const before = client.calls(),
    used = () => client.calls() - before;
  try {
    const read = await readWholeList(
      client,
      claim.list_id,
      options.workspaceId,
    );
    const db = await pool.connect();
    let stale = false;
    try {
      await db.query('BEGIN');
      stale = (await applyRead(db, claim, options, read, used())).stale;
      await db.query('COMMIT');
    } catch (e) {
      await db.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      db.release();
    }
    if (stale)
      await pool.query(
        "UPDATE clickup_sync_runs SET state='failed',finished_at=now(),error_code='link_deactivated',http_calls=$2 WHERE id=$1",
        [claim.run_id, used()],
      );
    return { ok: !stale, pauseSeconds: 0 };
  } catch (e) {
    if (!(e instanceof ClickUpError)) {
      // Database or programming failure: leave a trace without provider data and propagate.
      await recordFailure(
        pool,
        claim,
        options,
        'internal',
        null,
        null,
        used(),
      ).catch(() => undefined);
      throw e;
    }
    await recordFailure(
      pool,
      claim,
      options,
      e.code,
      e.httpStatus,
      e.retryAfterSeconds,
      used(),
    );
    return { ok: false, pauseSeconds: e.retryAfterSeconds ?? 0 };
  }
}
/** Works through due lists; stops at a rate limit, since the limit is the token's. */
export async function runDueSyncs(
  pool: Pool,
  client: ClickUpClient,
  options: SyncOptions,
  limit = 50,
) {
  let processed = 0;
  while (processed < limit) {
    const claim = await claimDueLink(pool, options.organizationId);
    if (!claim) return { processed, pauseSeconds: 0 };
    processed++;
    const { pauseSeconds } = await syncClaimed(pool, client, claim, options);
    if (pauseSeconds) return { processed, pauseSeconds };
  }
  return { processed, pauseSeconds: 0 };
}
