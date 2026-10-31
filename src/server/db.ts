import pg from 'pg';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 5000,
  statement_timeout: 5000,
});
