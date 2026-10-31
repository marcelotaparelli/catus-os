import { pool } from '../src/server/db';
let ready = false;
try {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await pool.query('SELECT 1');
      ready = true;
      break;
    } catch {
      await Bun.sleep(500);
    }
  }
  if (!ready) throw new Error('PostgreSQL did not become ready');
  console.log('PostgreSQL query verified');
} finally {
  await pool.end();
}
