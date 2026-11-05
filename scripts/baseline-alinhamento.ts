// Só lê, em transação READ ONLY: uso `bun run baseline:alinhamento [AAAA-MM-DD]`.
import { pool } from '../src/server/db';
import { runBaseline } from './lib/baseline';

const since = process.argv[2] ?? '2000-01-01';
if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new Error('Data: AAAA-MM-DD');
const client = await pool.connect();
try {
  console.log(JSON.stringify(await runBaseline(client, since), null, 2));
} finally {
  client.release();
  await pool.end();
}
