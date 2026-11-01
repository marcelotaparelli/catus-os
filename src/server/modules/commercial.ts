import { InputError, text, uuid } from '../../shared/domain';
import { currencies } from '../../shared/commercial';
import type { ScopeItem } from '../../shared/commercial';
import { authorize, audit } from '../auth/policy';
import type { Context } from '../auth/policy';
import { HttpError } from '../errors';
import { reserveCreation, completeCreation } from '../idempotency';
function fields(body: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(body).some((k) => !allowed.includes(k)))
    throw new InputError('Campo não permitido');
}
function version(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    throw new InputError('Versão obrigatória');
  return Number(value);
}
function sameVersion(row: { version: number }, value: unknown) {
  if (row.version !== version(value))
    throw new HttpError(409, 'Registro alterado; recarregue os dados');
}
function date(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  )
    throw new InputError('Data ISO inválida');
  return value;
}
async function event(
  ctx: Context,
  type: string,
  id: string,
  action: string,
  before: unknown,
  after: unknown,
) {
  await ctx.db.query(
    'INSERT INTO commercial_events(id,organization_id,entity_type,entity_id,action,actor_user_id,actor_role,before_data,after_data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [
      crypto.randomUUID(),
      ctx.organizationId,
      type,
      id,
      action,
      ctx.userId,
      ctx.role,
      JSON.stringify(before),
      JSON.stringify(after),
    ],
  );
  await audit(ctx, type, id, action);
}
async function project(ctx: Context, id: unknown) {
  const row = (
    await ctx.db.query(
      'SELECT * FROM projects WHERE id=$1 AND organization_id=$2',
      [uuid(id), ctx.organizationId],
    )
  ).rows[0];
  if (!row) throw new HttpError(404, 'Projeto não encontrado');
  return row;
}
async function projectLock(ctx: Context, id: string) {
  await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,3))', [
    ctx.organizationId + ':commercial:' + id,
  ]);
}
async function getScope(ctx: Context, id: unknown) {
  const row = (
    await ctx.db.query(
      'SELECT * FROM scope_versions WHERE id=$1 AND organization_id=$2',
      [uuid(id), ctx.organizationId],
    )
  ).rows[0];
  if (!row) throw new HttpError(404, 'Escopo não encontrado');
  return row;
}
async function lockedScope(ctx: Context, id: unknown) {
  const found = await getScope(ctx, id);
  await projectLock(ctx, found.project_id);
  return (
    await ctx.db.query(
      'SELECT * FROM scope_versions WHERE id=$1 AND organization_id=$2 FOR UPDATE',
      [found.id, ctx.organizationId],
    )
  ).rows[0];
}
async function scopeData(ctx: Context, id: string) {
  const row = await getScope(ctx, id);
  row.items = (
    await ctx.db.query(
      'SELECT * FROM scope_items WHERE scope_id=$1 AND organization_id=$2 ORDER BY position',
      [id, ctx.organizationId],
    )
  ).rows;
  row.decision =
    (
      await ctx.db.query(
        'SELECT * FROM scope_decisions WHERE scope_id=$1 AND organization_id=$2',
        [id, ctx.organizationId],
      )
    ).rows[0] ?? null;
  return row;
}
async function contract(ctx: Context, id: unknown, pid: string) {
  const row = (
    await ctx.db.query(
      "SELECT *,state='active' AND (now() AT TIME ZONE 'UTC')::date BETWEEN valid_from AND valid_until usable FROM contracts WHERE id=$1 AND organization_id=$2 AND project_id=$3 FOR SHARE",
      [uuid(id), ctx.organizationId, pid],
    )
  ).rows[0];
  if (!row) throw new HttpError(404, 'Contrato não encontrado neste projeto');
  return row;
}
async function parseItems(
  ctx: Context,
  value: unknown,
  pid: string,
): Promise<ScopeItem[]> {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20)
    throw new InputError('Informe de 1 a 20 itens de escopo');
  const result: ScopeItem[] = [];
  for (const v of value) {
    if (!v || typeof v !== 'object' || Array.isArray(v))
      throw new InputError('Item inválido');
    const b = v as Record<string, unknown>;
    fields(b, [
      'description',
      'deliverables',
      'exclusions',
      'acceptance_criteria',
      'dependencies',
      'origin_interaction_id',
      'origin_request_id',
    ]);
    const interaction =
        b.origin_interaction_id == null ? null : uuid(b.origin_interaction_id),
      request = b.origin_request_id == null ? null : uuid(b.origin_request_id);
    if (!interaction && !request)
      throw new InputError('Origem do item obrigatória');
    if (
      interaction &&
      !(
        await ctx.db.query(
          'SELECT 1 FROM interactions WHERE id=$1 AND organization_id=$2 AND project_id=$3',
          [interaction, ctx.organizationId, pid],
        )
      ).rowCount
    )
      throw new HttpError(
        404,
        'Atendimento de origem não encontrado neste projeto',
      );
    if (
      request &&
      !(
        await ctx.db.query(
          'SELECT 1 FROM requests r JOIN interactions i ON i.id=r.interaction_id AND i.organization_id=r.organization_id WHERE r.id=$1 AND r.organization_id=$2 AND i.project_id=$3 AND ($4::uuid IS NULL OR i.id=$4)',
          [request, ctx.organizationId, pid, interaction],
        )
      ).rowCount
    )
      throw new HttpError(
        404,
        'Demanda de origem não encontrada neste projeto',
      );
    result.push({
      description: text(b.description, 'Descrição', 2000),
      deliverables: text(b.deliverables, 'Entregáveis', 2000),
      exclusions: text(b.exclusions, 'Exclusões', 2000),
      acceptance_criteria: text(
        b.acceptance_criteria,
        'Critérios de aceite',
        2000,
      ),
      dependencies: text(b.dependencies, 'Dependências', 2000),
      origin_interaction_id: interaction,
      origin_request_id: request,
    });
  }
  return result;
}
async function insertItems(ctx: Context, sid: string, items: ScopeItem[]) {
  for (const [i, item] of items.entries())
    await ctx.db.query(
      'INSERT INTO scope_items(id,organization_id,scope_id,position,description,deliverables,exclusions,acceptance_criteria,dependencies,origin_interaction_id,origin_request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [
        crypto.randomUUID(),
        ctx.organizationId,
        sid,
        i + 1,
        item.description,
        item.deliverables,
        item.exclusions,
        item.acceptance_criteria,
        item.dependencies,
        item.origin_interaction_id,
        item.origin_request_id,
      ],
    );
}
async function contributor(ctx: Context, id: string) {
  await ctx.db.query(
    'INSERT INTO scope_contributors(scope_id,organization_id,user_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
    [id, ctx.organizationId, ctx.userId],
  );
}
export async function commercialSnapshot(ctx: Context) {
  authorize(ctx, 'read');
  // Single snapshot includes decisions and items: no cross-tenant joins or individually refreshed versions.
  return (
    await ctx.db.query(
      `SELECT
 COALESCE((SELECT jsonb_agg(c ORDER BY created_at,id) FROM contracts c WHERE organization_id=$1),'[]') contracts,
 COALESCE((SELECT jsonb_agg(x ORDER BY number) FROM (SELECT s.*,COALESCE((SELECT jsonb_agg(i ORDER BY position) FROM scope_items i WHERE i.scope_id=s.id AND i.organization_id=$1),'[]') items,(SELECT to_jsonb(d) FROM scope_decisions d WHERE d.scope_id=s.id AND d.organization_id=$1) decision FROM scope_versions s WHERE s.organization_id=$1) x),'[]') scopes,
 COALESCE((SELECT jsonb_agg(c ORDER BY created_at,id) FROM change_requests c WHERE organization_id=$1),'[]') changes,
 (SELECT to_jsonb(p) FROM commercial_policies p WHERE organization_id=$1) policy,
 COALESCE((SELECT jsonb_agg(e ORDER BY created_at DESC,id) FROM (SELECT * FROM commercial_events WHERE organization_id=$1 ORDER BY created_at DESC,id LIMIT 200) e),'[]') events`,
      [ctx.organizationId],
    )
  ).rows[0];
}
export async function setCommercialPolicy(
  ctx: Context,
  b: Record<string, unknown>,
) {
  authorize(ctx, 'admin');
  fields(b, ['version', 'approval_roles']);
  if (
    !Array.isArray(b.approval_roles) ||
    b.approval_roles.length < 1 ||
    b.approval_roles.length > 2 ||
    new Set(b.approval_roles).size !== b.approval_roles.length ||
    b.approval_roles.some(
      (r) => !['manager', 'administrator'].includes(String(r)),
    )
  )
    throw new InputError('Alçadas limitadas a gestor e administrador');
  await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,4))', [
    ctx.organizationId,
  ]);
  const before = (
    await ctx.db.query(
      'SELECT * FROM commercial_policies WHERE organization_id=$1 FOR UPDATE',
      [ctx.organizationId],
    )
  ).rows[0];
  if (before) {
    if (b.version === 0) throw new HttpError(409, 'Política mudou; recarregue');
    sameVersion(before, b.version);
  } else if (b.version !== 0)
    throw new HttpError(409, 'Política mudou; recarregue');
  const after = (
    await ctx.db.query(
      'INSERT INTO commercial_policies(organization_id,approval_roles,updated_by) VALUES($1,$2,$3) ON CONFLICT(organization_id) DO UPDATE SET approval_roles=EXCLUDED.approval_roles,updated_by=EXCLUDED.updated_by,version=commercial_policies.version+1,updated_at=now() RETURNING *',
      [ctx.organizationId, b.approval_roles, ctx.userId],
    )
  ).rows[0];
  await event(
    ctx,
    'commercial_policy',
    ctx.organizationId,
    'configured',
    before ?? null,
    after,
  );
  return after;
}
export async function createContract(ctx: Context, b: Record<string, unknown>) {
  authorize(ctx, 'create');
  fields(b, [
    'project_id',
    'client_id',
    'title',
    'kind',
    'currency',
    'valid_from',
    'valid_until',
    'document_reference',
  ]);
  const p = await project(ctx, b.project_id);
  if (uuid(b.client_id) !== p.client_id)
    throw new InputError('Cliente não corresponde ao projeto');
  if (!['fixed_price', 'retainer'].includes(String(b.kind)))
    throw new InputError('Tipo contratual inválido');
  if (!currencies.includes(b.currency as (typeof currencies)[number]))
    throw new InputError('Moeda não suportada');
  const start = date(b.valid_from),
    end = date(b.valid_until);
  if (end < start) throw new InputError('Vigência inválida');
  const id = crypto.randomUUID();
  const after = (
    await ctx.db.query(
      'INSERT INTO contracts(id,organization_id,project_id,client_id,title,kind,currency,valid_from,valid_until,document_reference,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
      [
        id,
        ctx.organizationId,
        p.id,
        p.client_id,
        text(b.title, 'Título'),
        b.kind,
        b.currency,
        start,
        end,
        text(b.document_reference, 'Referência documental', 2000),
        ctx.userId,
      ],
    )
  ).rows[0];
  await event(ctx, 'contract', id, 'created', null, after);
  return after;
}
export async function updateContract(
  ctx: Context,
  id: string,
  b: Record<string, unknown>,
) {
  authorize(ctx, 'create');
  fields(b, [
    'version',
    'title',
    'kind',
    'currency',
    'valid_from',
    'valid_until',
    'document_reference',
    'state',
  ]);
  const before = (
    await ctx.db.query(
      'SELECT * FROM contracts WHERE id=$1 AND organization_id=$2 FOR UPDATE',
      [uuid(id), ctx.organizationId],
    )
  ).rows[0];
  if (!before) throw new HttpError(404, 'Contrato não encontrado');
  sameVersion(before, b.version);
  const state = b.state ?? before.state;
  if (!['draft', 'active', 'closed'].includes(String(state)))
    throw new InputError('Estado contratual inválido');
  if (
    state !== before.state &&
    !['manager', 'administrator'].includes(ctx.role)
  )
    throw new HttpError(
      403,
      'Gestor/admin deve registrar ativação ou encerramento contratual',
    );
  if (
    state !== before.state &&
    !(
      (before.state === 'draft' &&
        ['active', 'closed'].includes(String(state))) ||
      (before.state === 'active' && state === 'closed')
    )
  )
    throw new HttpError(409, 'Transição contratual inválida');
  const terms = [
    'title',
    'kind',
    'currency',
    'valid_from',
    'valid_until',
    'document_reference',
  ];
  if (before.state !== 'draft' && terms.some((k) => k in b))
    throw new HttpError(
      409,
      'Termos ativados são imutáveis; cadastre outro contrato',
    );
  const title = 'title' in b ? text(b.title, 'Título') : before.title,
    kind = b.kind ?? before.kind,
    currency = b.currency ?? before.currency;
  if (
    !['fixed_price', 'retainer'].includes(String(kind)) ||
    !currencies.includes(currency)
  )
    throw new InputError('Tipo/moeda inválido');
  const start =
      'valid_from' in b
        ? date(b.valid_from)
        : new Date(before.valid_from).toISOString().slice(0, 10),
    end =
      'valid_until' in b
        ? date(b.valid_until)
        : new Date(before.valid_until).toISOString().slice(0, 10);
  if (end < start) throw new InputError('Vigência inválida');
  const after = (
    await ctx.db.query(
      'UPDATE contracts SET title=$3,kind=$4,currency=$5,valid_from=$6,valid_until=$7,document_reference=$8,state=$9,version=version+1,updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING *',
      [
        before.id,
        ctx.organizationId,
        title,
        kind,
        currency,
        start,
        end,
        'document_reference' in b
          ? text(b.document_reference, 'Referência documental', 2000)
          : before.document_reference,
        state,
      ],
    )
  ).rows[0];
  await event(ctx, 'contract', before.id, 'updated', before, after);
  return after;
}
async function newScope(
  ctx: Context,
  pid: string,
  contractId: string,
  title: string,
  items: ScopeItem[],
  previous: string | null,
) {
  const pending = await ctx.db.query(
    "SELECT 1 FROM scope_versions WHERE organization_id=$1 AND project_id=$2 AND state IN ('draft','submitted')",
    [ctx.organizationId, pid],
  );
  if (pending.rowCount)
    throw new HttpError(
      409,
      'Já existe uma versão em preparação neste projeto',
    );
  await contract(ctx, contractId, pid);
  const num = Number(
    (
      await ctx.db.query(
        'SELECT COALESCE(max(number),0)+1 n FROM scope_versions WHERE organization_id=$1 AND project_id=$2',
        [ctx.organizationId, pid],
      )
    ).rows[0].n,
  );
  const id = crypto.randomUUID();
  await ctx.db.query(
    'INSERT INTO scope_versions(id,organization_id,project_id,contract_id,number,title,previous_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, ctx.organizationId, pid, contractId, num, title, previous, ctx.userId],
  );
  await insertItems(ctx, id, items);
  if (previous)
    await ctx.db.query(
      'INSERT INTO scope_contributors(scope_id,organization_id,user_id) SELECT $1,organization_id,user_id FROM scope_contributors WHERE scope_id=$2 AND organization_id=$3 ON CONFLICT DO NOTHING',
      [id, previous, ctx.organizationId],
    );
  await contributor(ctx, id);
  const after = await scopeData(ctx, id);
  await event(ctx, 'scope', id, 'created', null, after);
  return after;
}
export async function createScope(ctx: Context, b: Record<string, unknown>) {
  authorize(ctx, 'create');
  fields(b, ['project_id', 'contract_id', 'title', 'items']);
  const p = await project(ctx, b.project_id);
  await projectLock(ctx, p.id);
  if (
    (
      await ctx.db.query(
        'SELECT 1 FROM scope_versions WHERE organization_id=$1 AND project_id=$2',
        [ctx.organizationId, p.id],
      )
    ).rowCount
  )
    throw new HttpError(
      409,
      'Use revisão ou change request para criar outra versão',
    );
  return newScope(
    ctx,
    p.id,
    uuid(b.contract_id),
    text(b.title, 'Título'),
    await parseItems(ctx, b.items, p.id),
    null,
  );
}
export async function editScope(
  ctx: Context,
  id: string,
  b: Record<string, unknown>,
) {
  authorize(ctx, 'create');
  fields(b, ['version', 'title', 'contract_id', 'items']);
  const s = await lockedScope(ctx, id);
  sameVersion(s, b.version);
  if (s.state !== 'draft')
    throw new HttpError(409, 'Somente rascunhos podem ser editados');
  const before = await scopeData(ctx, s.id),
    cid = uuid(b.contract_id);
  await contract(ctx, cid, s.project_id);
  const items = await parseItems(ctx, b.items, s.project_id);
  await ctx.db.query(
    'DELETE FROM scope_items WHERE scope_id=$1 AND organization_id=$2',
    [s.id, ctx.organizationId],
  );
  await ctx.db.query(
    'UPDATE scope_versions SET title=$3,contract_id=$4,version=version+1 WHERE id=$1 AND organization_id=$2',
    [s.id, ctx.organizationId, text(b.title, 'Título'), cid],
  );
  await insertItems(ctx, s.id, items);
  await contributor(ctx, s.id);
  const after = await scopeData(ctx, s.id);
  await event(ctx, 'scope', s.id, 'edited', before, after);
  return after;
}
export async function submitScope(
  ctx: Context,
  id: string,
  b: Record<string, unknown>,
) {
  authorize(ctx, 'create');
  fields(b, ['version']);
  const s = await lockedScope(ctx, id);
  sameVersion(s, b.version);
  if (s.state !== 'draft') throw new HttpError(409, 'Escopo não é rascunho');
  if (
    !(
      await ctx.db.query(
        'SELECT 1 FROM scope_items WHERE scope_id=$1 AND organization_id=$2',
        [s.id, ctx.organizationId],
      )
    ).rowCount
  )
    throw new InputError('Escopo sem itens');
  const before = await scopeData(ctx, s.id);
  await ctx.db.query(
    "UPDATE scope_versions SET state='submitted',submitted_by=$3,submitted_at=now(),version=version+1 WHERE id=$1 AND organization_id=$2",
    [s.id, ctx.organizationId, ctx.userId],
  );
  await contributor(ctx, s.id);
  const after = await scopeData(ctx, s.id);
  await event(ctx, 'scope', s.id, 'submitted', before, after);
  return after;
}
export async function reviseScope(
  ctx: Context,
  id: string,
  b: Record<string, unknown>,
) {
  authorize(ctx, 'create');
  fields(b, ['version']);
  const s = await lockedScope(ctx, id);
  sameVersion(s, b.version);
  if (s.state !== 'rejected')
    throw new HttpError(
      409,
      'Revisão simples exige rejeição; para aprovado use change request',
    );
  if (
    (
      await ctx.db.query(
        'SELECT 1 FROM change_requests WHERE proposed_scope_id=$1 AND organization_id=$2',
        [s.id, ctx.organizationId],
      )
    ).rowCount
  )
    throw new HttpError(
      409,
      'Change request rejeitado: prepare novo change request da versão aprovada',
    );
  const old = await scopeData(ctx, s.id);
  return newScope(ctx, s.project_id, s.contract_id, s.title, old.items, s.id);
}
export async function createChange(ctx: Context, b: Record<string, unknown>) {
  authorize(ctx, 'create');
  fields(b, ['base_scope_id', 'version', 'reason', 'impact']);
  const s = await lockedScope(ctx, b.base_scope_id);
  sameVersion(s, b.version);
  if (s.state !== 'approved')
    throw new HttpError(
      409,
      'Change request exige a versão atualmente aprovada',
    );
  const reason = text(b.reason, 'Motivo', 2000),
    impact = text(b.impact, 'Impacto descritivo', 4000),
    old = await scopeData(ctx, s.id);
  const proposed = await newScope(
      ctx,
      s.project_id,
      s.contract_id,
      s.title,
      old.items,
      s.id,
    ),
    id = crypto.randomUUID();
  const after = (
    await ctx.db.query(
      'INSERT INTO change_requests(id,organization_id,project_id,base_scope_id,proposed_scope_id,reason,impact,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [
        id,
        ctx.organizationId,
        s.project_id,
        s.id,
        proposed.id,
        reason,
        impact,
        ctx.userId,
      ],
    )
  ).rows[0];
  await event(ctx, 'change_request', id, 'created', null, after);
  return { ...after, scope: proposed };
}
export async function decideScope(
  ctx: Context,
  id: string,
  b: Record<string, unknown>,
) {
  authorize(ctx, 'read');
  fields(b, ['version', 'decision', 'reason']);
  if (!['manager', 'administrator'].includes(ctx.role))
    throw new HttpError(403, 'Sem competência para decidir escopo');
  if (!['approved', 'rejected'].includes(String(b.decision)))
    throw new InputError('Decisão inválida');
  const reason = text(b.reason, 'Justificativa da decisão', 2000);
  const s = await lockedScope(ctx, id);
  sameVersion(s, b.version);
  if (s.state !== 'submitted')
    throw new HttpError(409, 'Somente versão submetida pode receber decisão');
  const policy = (
    await ctx.db.query(
      'SELECT * FROM commercial_policies WHERE organization_id=$1 FOR SHARE',
      [ctx.organizationId],
    )
  ).rows[0];
  if (!policy || !policy.approval_roles.includes(ctx.role))
    throw new HttpError(403, 'Alçada não configurada para este papel');
  if (
    s.created_by === ctx.userId ||
    s.submitted_by === ctx.userId ||
    (
      await ctx.db.query(
        'SELECT 1 FROM scope_contributors WHERE scope_id=$1 AND organization_id=$2 AND user_id=$3',
        [s.id, ctx.organizationId, ctx.userId],
      )
    ).rowCount
  )
    throw new HttpError(
      403,
      'Autor/preparador não pode decidir o próprio escopo',
    );
  const before = await scopeData(ctx, s.id);
  const change = (
    await ctx.db.query(
      'SELECT * FROM change_requests WHERE proposed_scope_id=$1 AND organization_id=$2 FOR UPDATE',
      [s.id, ctx.organizationId],
    )
  ).rows[0];
  if (b.decision === 'approved') {
    const c = await contract(ctx, s.contract_id, s.project_id);
    if (!c.usable)
      throw new HttpError(
        409,
        'Aprovação exige contrato ativo e vigente em UTC',
      );
    const current = (
      await ctx.db.query(
        "SELECT * FROM scope_versions WHERE project_id=$1 AND organization_id=$2 AND state='approved' FOR UPDATE",
        [s.project_id, ctx.organizationId],
      )
    ).rows[0];
    if (current && (!change || current.id !== change.base_scope_id))
      throw new HttpError(409, 'Base aprovada mudou; revise o change request');
    if (current) {
      const old = await scopeData(ctx, current.id);
      await ctx.db.query(
        "UPDATE scope_versions SET state='superseded',version=version+1 WHERE id=$1 AND organization_id=$2",
        [current.id, ctx.organizationId],
      );
      await event(
        ctx,
        'scope',
        current.id,
        'superseded',
        old,
        await scopeData(ctx, current.id),
      );
    }
  }
  await ctx.db.query(
    'INSERT INTO scope_decisions(scope_id,organization_id,decision,actor_user_id,actor_role,policy_version,policy_roles,scope_version,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [
      s.id,
      ctx.organizationId,
      b.decision,
      ctx.userId,
      ctx.role,
      policy.version,
      policy.approval_roles,
      s.version,
      reason,
    ],
  );
  await ctx.db.query(
    'UPDATE scope_versions SET state=$3,version=version+1 WHERE id=$1 AND organization_id=$2',
    [s.id, ctx.organizationId, b.decision],
  );
  if (change) {
    await ctx.db.query(
      'UPDATE change_requests SET state=$3 WHERE id=$1 AND organization_id=$2',
      [change.id, ctx.organizationId, b.decision],
    );
    await event(ctx, 'change_request', change.id, String(b.decision), change, {
      ...change,
      state: b.decision,
    });
  }
  const after = await scopeData(ctx, s.id);
  await event(ctx, 'scope', s.id, String(b.decision), before, after);
  return after;
}
export async function linkCoverage(
  ctx: Context,
  id: string,
  b: Record<string, unknown>,
) {
  authorize(ctx, 'create');
  fields(b, ['version', 'scope_item_id']);
  const before = (
    await ctx.db.query(
      'SELECT r.* FROM requests r WHERE r.id=$1 AND r.organization_id=$2 FOR UPDATE',
      [uuid(id), ctx.organizationId],
    )
  ).rows[0];
  if (!before) throw new HttpError(404, 'Demanda não encontrada');
  sameVersion(before, b.version);
  const item = b.scope_item_id === null ? null : uuid(b.scope_item_id);
  if (item) {
    const linked = (
      await ctx.db.query(
        `SELECT s.id FROM scope_items si JOIN scope_versions s ON s.id=si.scope_id AND s.organization_id=si.organization_id JOIN contracts c ON c.id=s.contract_id AND c.organization_id=s.organization_id JOIN interactions i ON i.project_id=s.project_id AND i.organization_id=s.organization_id WHERE si.id=$1 AND si.organization_id=$2 AND i.id=$3 AND s.state='approved' AND c.state='active' AND (now() AT TIME ZONE 'UTC')::date BETWEEN c.valid_from AND c.valid_until FOR SHARE OF s,c`,
        [item, ctx.organizationId, before.interaction_id],
      )
    ).rows[0];
    if (!linked)
      throw new HttpError(409, 'Item não está aprovado/vigente neste projeto');
  }
  const after = (
    await ctx.db.query(
      'UPDATE requests SET scope_item_id=$3,version=version+1,updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING *',
      [before.id, ctx.organizationId, item],
    )
  ).rows[0];
  await event(
    ctx,
    'coverage',
    before.id,
    item ? 'linked' : 'unlinked',
    before,
    after,
  );
  return after;
}
// Every M3 creation and decision is transactionally idempotent, after current permission checks.
export async function commercialRoute(
  ctx: Context,
  path: string,
  method: string,
  body: Record<string, unknown> | undefined,
  key: string | null,
): Promise<Response | undefined> {
  if (method === 'GET' && path === '/api/commercial')
    return Response.json(await commercialSnapshot(ctx));
  if (!body) return undefined;
  if (method === 'PATCH') {
    const m = /^\/api\/(contracts|scopes)\/([^/]+)$/.exec(path);
    if (!m) return undefined;
    return Response.json(
      m[1] === 'contracts'
        ? await updateContract(ctx, m[2]!, body)
        : await editScope(ctx, m[2]!, body),
    );
  }
  if (method !== 'POST') return undefined;
  if (path === '/api/commercial/policy')
    return Response.json(await setCommercialPolicy(ctx, body));
  const match = /^\/api\/scopes\/([^/]+)\/(submit|decide|revisions)$/.exec(
      path,
    ),
    coverage = /^\/api\/requests\/([^/]+)\/coverage$/.exec(path);
  if (
    !['/api/contracts', '/api/scopes', '/api/change-requests'].includes(path) &&
    !match &&
    !coverage
  )
    return undefined;
  if (match?.[2] === 'decide') {
    if (!['manager', 'administrator'].includes(ctx.role))
      throw new HttpError(403, 'Sem competência para decidir escopo');
  } else authorize(ctx, 'create');
  // Revalidate alçada and contribution even for a previously completed replay.
  if (match?.[2] === 'decide') {
    const s = await getScope(ctx, match[1]);
    const p = (
      await ctx.db.query(
        'SELECT approval_roles FROM commercial_policies WHERE organization_id=$1 FOR SHARE',
        [ctx.organizationId],
      )
    ).rows[0];
    if (
      !p?.approval_roles.includes(ctx.role) ||
      (
        await ctx.db.query(
          'SELECT 1 FROM scope_contributors WHERE scope_id=$1 AND organization_id=$2 AND user_id=$3',
          [s.id, ctx.organizationId, ctx.userId],
        )
      ).rowCount
    )
      throw new HttpError(403, 'Alçada insuficiente ou autoaprovação');
  }
  const previous = await reserveCreation(ctx, path, key, body);
  if (previous)
    return Response.json(previous.body, {
      status: previous.status,
      headers: { 'Idempotency-Replayed': 'true' },
    });
  let result: unknown,
    code = 200;
  if (path === '/api/contracts') {
    result = await createContract(ctx, body);
    code = 201;
  } else if (path === '/api/scopes') {
    result = await createScope(ctx, body);
    code = 201;
  } else if (path === '/api/change-requests') {
    result = await createChange(ctx, body);
    code = 201;
  } else if (coverage) result = await linkCoverage(ctx, coverage[1]!, body);
  else if (match?.[2] === 'submit')
    result = await submitScope(ctx, match[1]!, body);
  else if (match?.[2] === 'decide')
    result = await decideScope(ctx, match[1]!, body);
  else if (match) {
    result = await reviseScope(ctx, match[1]!, body);
    code = 201;
  }
  const response = Response.json(result, { status: code });
  await completeCreation(ctx, path, key!, response);
  return response;
}
