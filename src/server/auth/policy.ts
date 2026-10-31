import type { PoolClient } from 'pg';
import type { Role } from '../../shared/identity';
import { HttpError } from '../errors';
export interface Context {
  db: PoolClient;
  userId: string;
  organizationId: string;
  role: Role;
  name: string;
  sessionId: string;
  csrfToken: string;
  expiresAt: Date;
  email: string;
}
export type Permission = 'read' | 'create' | 'update' | 'admin' | 'audit';
const grants: Record<Role, readonly Permission[]> = {
  administrator: ['read', 'create', 'update', 'admin', 'audit'],
  manager: ['read', 'create', 'update', 'audit'],
  po: ['read', 'create', 'update'],
  developer: ['read', 'update'],
};
export function authorize(ctx: Context, permission: Permission) {
  if (!grants[ctx.role]?.includes(permission))
    throw new HttpError(403, 'Operação não permitida');
}
export async function audit(
  ctx: Context,
  type: string,
  id: string,
  action: string,
) {
  await ctx.db.query(
    'INSERT INTO audit_events(organization_id,actor_user_id,actor,entity_type,entity_id,request_id,action) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [
      ctx.organizationId,
      ctx.userId,
      ctx.name,
      type,
      id,
      type === 'request' ? id : null,
      action,
    ],
  );
}
