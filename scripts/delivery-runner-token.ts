// Offline local operator provisioning only. The runner never receives a PostgreSQL URL.
import pg from 'pg';
import { randomBytes, createHash } from 'node:crypto';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { uuid } from '../src/shared/domain';
const args = process.argv.slice(2),
  revoke = args[0] === '--revoke';
if (revoke) args.shift();
const [orgValue, projectValue, destination] = args;
if (
  !process.env.MIGRATION_DATABASE_URL ||
  !orgValue ||
  !projectValue ||
  !destination
)
  throw new Error(
    'Usage: delivery:token [--revoke] <org UUID> <project UUID> <new private .local file OR runner UUID>',
  );
const connection = new URL(process.env.MIGRATION_DATABASE_URL);
if (
  !['localhost', '127.0.0.1'].includes(connection.hostname) ||
  !/^\/(?:catus|[a-z][a-z0-9_]*_test)$/.test(connection.pathname)
)
  throw new Error('Only local homologation/test databases allowed');
const org = uuid(orgValue),
  project = uuid(projectValue),
  out = resolve(destination);
if (!revoke && (!out.startsWith(resolve('.local') + '/') || existsSync(out)))
  throw new Error(
    'New ignored .local file required; never overwrite credentials',
  );
const db = new pg.Client({ connectionString: connection.href });
await db.connect();
try {
  await db.query('BEGIN');
  if (revoke) {
    const id = uuid(destination);
    if (
      !(
        await db.query(
          'UPDATE delivery_runners SET revoked_at=now() WHERE id=$1 AND organization_id=$2 AND project_id=$3 RETURNING id',
          [id, org, project],
        )
      ).rowCount
    )
      throw new Error('Not found');
    await db.query(
      "INSERT INTO delivery_events(id,organization_id,entity_id,actor,action,data) VALUES($1,$2,$3,'offline-runner-provision','runner_credential_revoked',$4)",
      [crypto.randomUUID(), org, id, JSON.stringify({ project_id: project })],
    );
  } else {
    if (
      !(
        await db.query(
          'SELECT 1 FROM delivery_policies WHERE organization_id=$1 AND project_id=$2 AND enabled',
          [org, project],
        )
      ).rowCount
    )
      throw new Error('Explicit enabled project policy required');
    const token = randomBytes(32).toString('base64url'),
      id = crypto.randomUUID();
    await db.query(
      "INSERT INTO delivery_runners(id,organization_id,project_id,token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '8 hours')",
      [id, org, project, createHash('sha256').update(token).digest('hex')],
    );
    await db.query(
      "INSERT INTO delivery_events(id,organization_id,entity_id,actor,action,data) VALUES($1,$2,$3,'offline-runner-provision','runner_credential_created',$4)",
      [
        crypto.randomUUID(),
        org,
        id,
        JSON.stringify({ project_id: project, expires_in_hours: 8 }),
      ],
    );
    mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
    writeFileSync(out, 'DELIVERY_RUNNER_TOKEN=' + token + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
  }
  await db.query('COMMIT');
  console.log(
    revoke
      ? 'Scoped runner credential revoked; in-flight work stops on the next heartbeat.'
      : 'Scoped runner credential created for 8h; private file written, value never printed. Transfer only to isolated runner account.',
  );
} catch {
  await db.query('ROLLBACK');
  throw new Error('Runner credential operation failed; no secret logged');
} finally {
  await db.end();
}
