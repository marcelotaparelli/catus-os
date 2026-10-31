import { pool } from '../db';
export async function getMissionControl() {
  // A consistent snapshot for dependent selectors and the board.
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const clients = (
      await c.query('SELECT id,name FROM clients ORDER BY created_at,id')
    ).rows;
    const projects = (
      await c.query(
        'SELECT id,client_id,name FROM projects ORDER BY created_at,id',
      )
    ).rows;
    const interactions = (
      await c.query(
        'SELECT * FROM interactions ORDER BY created_at DESC,id LIMIT 500',
      )
    ).rows;
    const requests = (
      await c.query(
        `SELECT r.*,p.name project_name,c.name client_name FROM requests r JOIN interactions i ON i.id=r.interaction_id JOIN projects p ON p.id=i.project_id JOIN clients c ON c.id=p.client_id ORDER BY r.updated_at DESC,r.id LIMIT 500`,
      )
    ).rows;
    await c.query('COMMIT');
    return { clients, projects, interactions, requests };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
