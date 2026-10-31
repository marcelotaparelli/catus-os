import { authorize } from '../auth/policy';
import type { Context } from '../auth/policy';
export async function getMembers(ctx: Context) {
  authorize(ctx, 'read');
  return (
    await ctx.db.query(
      'SELECT u.id,u.display_name name,u.email,m.role FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.organization_id=$1 AND u.active AND m.active ORDER BY u.display_name,u.id',
      [ctx.organizationId],
    )
  ).rows;
}
export async function getMissionControl(ctx: Context) {
  authorize(ctx, 'read');
  // One SQL statement gives all collections the same MVCC snapshot at READ COMMITTED.
  return (
    await ctx.db.query(
      `SELECT
 COALESCE((SELECT jsonb_agg(t) FROM (SELECT id,name FROM clients WHERE organization_id=$1 ORDER BY created_at,id) t),'[]'::jsonb) clients,
 COALESCE((SELECT jsonb_agg(t) FROM (SELECT id,client_id,name FROM projects WHERE organization_id=$1 ORDER BY created_at,id) t),'[]'::jsonb) projects,
 COALESCE((SELECT jsonb_agg(t) FROM (SELECT * FROM interactions WHERE organization_id=$1 ORDER BY created_at DESC,id LIMIT 500) t),'[]'::jsonb) interactions,
 COALESCE((SELECT jsonb_agg(t) FROM (SELECT r.id,r.interaction_id,r.origin_proposal_id,r.suggested_acceptance_criteria,r.title,r.description,r.status,r.owner_user_id,COALESCE(u.display_name,r.owner) owner,r.next_action,r.version,p.name project_name,c.name client_name FROM requests r JOIN interactions i ON i.id=r.interaction_id AND i.organization_id=r.organization_id JOIN projects p ON p.id=i.project_id AND p.organization_id=i.organization_id JOIN clients c ON c.id=p.client_id AND c.organization_id=p.organization_id LEFT JOIN users u ON u.id=r.owner_user_id WHERE r.organization_id=$1 ORDER BY r.updated_at DESC,r.id LIMIT 500) t),'[]'::jsonb) requests`,
      [ctx.organizationId],
    )
  ).rows[0];
}
export async function getAudit(ctx: Context) {
  authorize(ctx, 'audit');
  return (
    await ctx.db.query(
      'SELECT id,actor_user_id,actor,entity_type,entity_id,action,created_at FROM audit_events WHERE organization_id=$1 ORDER BY id DESC LIMIT 500',
      [ctx.organizationId],
    )
  ).rows;
}
