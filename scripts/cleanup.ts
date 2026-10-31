import pg from 'pg';
import { cleanup } from '../src/server/maintenance';
if (!process.env.MAINTENANCE_DATABASE_URL)
  throw new Error('MAINTENANCE_DATABASE_URL required');
const pool = new pg.Pool({
  connectionString: process.env.MAINTENANCE_DATABASE_URL,
});
const once = process.argv.includes('--once');
let stopping = false;
const stop = () => {
  stopping = true;
};
for (const s of ['SIGTERM', 'SIGINT'] as const) process.on(s, stop);
try {
  do {
    console.log('Cleanup:', await cleanup(pool));
    if (!once && !stopping)
      for (let i = 0; i < 60 && !stopping; i++) await Bun.sleep(1000);
  } while (!once && !stopping);
} finally {
  await pool.end();
}
