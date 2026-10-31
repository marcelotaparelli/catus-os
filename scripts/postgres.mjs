import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';
const db = new EmbeddedPostgres({
  databaseDir: '.local/postgres',
  user: 'catus',
  password: 'catus_local_only',
  port: 5432,
  persistent: true,
  authMethod: 'scram-sha-256',
  postgresFlags: ['-h', '127.0.0.1', '-k', '/tmp'],
  onLog: () => {},
  onError: console.error,
});
if (!existsSync('.local/postgres/PG_VERSION')) await db.initialise();
await db.start();
const client = db.getPgClient();
await client.connect();
if (
  !(await client.query("SELECT 1 FROM pg_database WHERE datname='catus'"))
    .rowCount
)
  await db.createDatabase('catus');
await client.end();
console.log(
  'PostgreSQL ready on 127.0.0.1:5432; database catus (local development only)',
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    await db.stop();
    process.exit(0);
  });
setInterval(() => {}, 60000);
