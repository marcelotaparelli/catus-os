import { pool } from '../db';
import { text, uuid } from '../../shared/domain';
export async function createProject(body: Record<string, unknown>) {
  return (
    await pool.query(
      'INSERT INTO projects(id,client_id,name) VALUES($1,$2,$3) RETURNING *',
      [crypto.randomUUID(), uuid(body.client_id), text(body.name, 'Nome')],
    )
  ).rows[0];
}
