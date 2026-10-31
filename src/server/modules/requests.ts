import { pool } from '../db';
import {
  InputError,
  text,
  uuid,
  status,
  transition,
} from '../../shared/domain';
import type { Status } from '../../shared/domain';
import { HttpError } from '../errors';
export async function createRequest(body: Record<string, unknown>) {
  const id = crypto.randomUUID();
  const values = [
    id,
    uuid(body.interaction_id),
    text(body.title, 'Título'),
    text(body.description, 'Descrição', 10000),
    text(body.owner, 'Responsável'),
    text(body.next_action, 'Próxima ação', 2000),
  ];
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const result = await c.query(
      "INSERT INTO requests(id,interaction_id,title,description,status,owner,next_action) VALUES($1,$2,$3,$4,'new',$5,$6) RETURNING *",
      values,
    );
    await c.query(
      "INSERT INTO audit_events(request_id,actor,action) VALUES($1,'local-developer','created')",
      [id],
    );
    await c.query('COMMIT');
    return result.rows[0];
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
export async function updateRequest(id: string, body: Record<string, unknown>) {
  const requestId = uuid(id);
  const next = status(body.status);
  const owner = text(body.owner, 'Responsável');
  const nextAction = text(body.next_action, 'Próxima ação', 2000);
  if (!Number.isSafeInteger(body.version) || Number(body.version) < 1)
    throw new InputError('Versão obrigatória');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const current = (
      await c.query<{ status: Status; version: number }>(
        'SELECT status,version FROM requests WHERE id=$1 FOR UPDATE',
        [requestId],
      )
    ).rows[0];
    if (!current) throw new HttpError(404, 'Solicitação não encontrada');
    if (current.version !== body.version)
      throw new HttpError(409, 'Solicitação alterada; recarregue os dados');
    transition(current.status, next);
    const result = await c.query(
      'UPDATE requests SET status=$2,owner=$3,next_action=$4,version=version+1,updated_at=now() WHERE id=$1 RETURNING *',
      [requestId, next, owner, nextAction],
    );
    await c.query(
      "INSERT INTO audit_events(request_id,actor,action) VALUES($1,'local-developer',$2)",
      [requestId, `${current.status}->${next}`],
    );
    await c.query('COMMIT');
    return result.rows[0];
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
