import { pool } from '../db';
import { InputError, text, uuid } from '../../shared/domain';
export async function createInteraction(body: Record<string, unknown>) {
  const id = crypto.randomUUID();
  if (body.kind !== 'meeting' && body.kind !== 'service')
    throw new InputError('Tipo inválido');
  const occurred = text(body.occurred_at, 'Data', 50);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}.*(?:Z|[+-]\d{2}:\d{2})$/.test(occurred) ||
    !Number.isFinite(Date.parse(occurred))
  )
    throw new InputError('Data ISO com fuso horário obrigatória');
  return (
    await pool.query(
      'INSERT INTO interactions(id,project_id,kind,summary,occurred_at) VALUES($1,$2,$3,$4,$5) RETURNING *',
      [
        id,
        uuid(body.project_id),
        body.kind,
        text(body.summary, 'Resumo', 10000),
        occurred,
      ],
    )
  ).rows[0];
}
