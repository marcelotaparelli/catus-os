import { pool } from '../db';
import { text } from '../../shared/domain';
export async function createClient(body: Record<string, unknown>) {
  return (
    await pool.query('INSERT INTO clients(id,name) VALUES($1,$2) RETURNING *', [
      crypto.randomUUID(),
      text(body.name, 'Nome'),
    ])
  ).rows[0];
}
