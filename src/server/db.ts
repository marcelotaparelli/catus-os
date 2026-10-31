import pg from 'pg';
if (!process.env.RUNTIME_DATABASE_URL && !process.env.DATABASE_URL)
  throw new Error('RUNTIME_DATABASE_URL required');
export const pool = new pg.Pool({
  connectionString:
    process.env.RUNTIME_DATABASE_URL ?? process.env.DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 5000,
  statement_timeout: 5000,
});

pool.on('error', () => console.error('Database idle connection failure'));
