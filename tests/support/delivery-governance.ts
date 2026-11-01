import { themeIntakeSource } from './delivery-fixture';
export type TestApi = <T = Record<string, unknown>>(
  who: string,
  path: string,
  body?: unknown,
  method?: string,
) => Promise<T>;
export async function governedTask(
  api: TestApi,
  developer: string,
  afterQueue: () => Promise<void>,
) {
  const client = await api<{ id: string }>('po', 'clients', {
      name: 'M5 Cliente Sintético',
    }),
    project = await api<{ id: string }>('po', 'projects', {
      client_id: client.id,
      name: 'M5 Nuvemshop Sintético',
    });
  const interaction = await api<{ id: string }>('po', 'interactions', {
    project_id: project.id,
    kind: 'meeting',
    summary: themeIntakeSource,
    occurred_at: '2026-11-01T10:00:00Z',
  });
  const ai = await api<{ policy?: unknown }>('po', 'extraction');
  if (!ai.policy)
    await api('admin', 'ai/policy', {
      enabled: true,
      policy_reference: 'M5-SYNTHETIC-ONLY',
      data_scope: 'synthetic',
      daily_budget_micro_usd: 1000000,
      per_job_budget_micro_usd: 100000,
      daily_job_limit: 100,
    });
  const queue = await api<{ id: string }>('po', 'extractions', {
    interaction_id: interaction.id,
    data_scope: 'synthetic',
    confirm_external_processing: true,
  });
  await afterQueue();
  let extraction:
    | { state: string; proposals: { id: string; version: number }[] }
    | undefined;
  for (let i = 0; i < 100; i++) {
    extraction = await api('po', 'extractions/' + queue.id);
    if (extraction?.state === 'succeeded') break;
    await new Promise((r) => setTimeout(r, 50));
  }
  if (extraction?.state !== 'succeeded')
    throw new Error('Synthetic intake did not complete');
  const response = await api<{ created: { request_id: string }[] }>(
    'po',
    'extractions/' + queue.id + '/approve',
    {
      confirm_human_review: true,
      acknowledge_duplicates: true,
      proposals: [
        {
          id: extraction.proposals[0]!.id,
          version: extraction.proposals[0]!.version,
          owner_user_id: developer,
          next_action: 'Preparar base comercial/econômica e revisar diff',
        },
      ],
    },
  );
  // Response carries request IDs; accept shape from the public M2 endpoint only.
  const requestId = response.created[0]!.request_id;
  const cv = await api<{ policy?: unknown }>('admin', 'commercial');
  if (!cv.policy)
    await api('admin', 'commercial/policy', {
      version: 0,
      approval_roles: ['manager', 'administrator'],
    });
  const contract = await api<{ id: string }>('po', 'contracts', {
    project_id: project.id,
    client_id: client.id,
    title: 'M5 Contrato Sintético',
    kind: 'fixed_price',
    currency: 'BRL',
    valid_from: '2020-01-01',
    valid_until: '2099-12-31',
    document_reference: 'SYNTHETIC-M5-CONTRACT',
  });
  await api(
    'manager',
    'contracts/' + contract.id,
    { version: 1, state: 'active' },
    'PATCH',
  );
  const scope = await api<{ id: string; items: { id: string }[] }>(
    'po',
    'scopes',
    {
      project_id: project.id,
      contract_id: contract.id,
      title: 'M5 Escopo Nuvemshop',
      items: [
        {
          description: 'Correção do h1 sintético Nuvemshop',
          deliverables: 'templates/home.tpl corrigido com diff',
          exclusions: 'Deploy, merge e dados reais',
          acceptance_criteria:
            'h1 acessível Bem-vindo à loja sintética e testes passando',
          dependencies: 'Repo fixture autorizado',
          origin_interaction_id: interaction.id,
          origin_request_id: requestId,
        },
      ],
    },
  );
  await api('po', 'scopes/' + scope.id + '/submit', { version: 1 });
  await api('manager', 'scopes/' + scope.id + '/decide', {
    version: 2,
    decision: 'approved',
    reason: 'Base sintética revisada independentemente',
  });
  await api('po', 'requests/' + requestId + '/coverage', {
    version: 1,
    scope_item_id: scope.items[0]!.id,
  });
  for (const [version, status] of [
    [2, 'triage'],
    [3, 'ready'],
  ] as const)
    await api(
      'po',
      'requests/' + requestId,
      {
        version,
        status,
        owner_user_id: developer,
        next_action: 'Execução isolada após política e revalidação',
      },
      'PATCH',
    );
  const existing = await api<{
    records: {
      id: string;
      kind: string;
      decision: string;
      payload: Record<string, unknown>;
    }[];
  }>('manager', 'economics');
  const prep = async (
    kind: string,
    payload: unknown,
    extra: Record<string, unknown> = {},
  ) => {
    const r = await api<{ id: string; revision: number }>(
      'admin',
      'economics/records',
      {
        kind,
        project_id: ['config', 'rate'].includes(kind) ? null : project.id,
        currency: 'BRL',
        valid_from: '2026-11-01',
        valid_until: '2026-11-30',
        source: 'SYNTHETIC-M5-' + kind,
        payload,
        previous_id: null,
        ...extra,
      },
    );
    await api('manager', 'economics/records/' + r.id + '/decide', {
      revision: r.revision,
      decision: 'approved',
      reason: 'Premissa sintética independente',
    });
    return r;
  };
  if (
    !existing.records.some(
      (r) => r.kind === 'config' && r.decision === 'approved',
    )
  )
    await prep(
      'config',
      {
        tax_bps: 0,
        commission_bps: 0,
        overhead_rule: 'none_explicit',
        overhead_minor_per_hour: null,
        weekdays: [1, 2, 3, 4, 5],
        minutes_per_day: 480,
        holidays: [],
      },
      { valid_from: '2026-01-01', valid_until: '2026-12-31' },
    );
  if (
    !existing.records.some(
      (r) =>
        r.kind === 'rate' &&
        r.decision === 'approved' &&
        r.payload.user_id === developer,
    )
  )
    await prep('rate', {
      user_id: developer,
      role: null,
      minor_per_hour: '6000',
    });
  const terms = await prep('terms', {
    contract_id: contract.id,
    scope_id: scope.id,
    amount_minor: '1000000',
    recognition_rule: 'manual',
    recognized_minor: '0',
    direct_costs_complete: true,
    time_entries_complete: true,
    included_minutes: null,
    overage_rule: 'none',
    overage_rate_minor: null,
    rollover_rule: 'none',
    rollover_cap_minutes: 0,
    carry_in_minutes: 0,
    prior_terms_id: null,
    change_request_id: null,
  });
  await prep('estimate', {
    terms_id: terms.id,
    request_id: requestId,
    user_id: developer,
    planned_minutes: 60,
    remaining_minutes: 60,
    expected_on: '2026-11-20',
  });
  await prep('capacity', { user_id: developer, available_minutes: 60 });
  const report = await api<{ id: string }>('manager', 'economics/reports', {
    terms_id: terms.id,
    as_of: '2026-11-01',
  });
  return {
    projectId: project.id,
    requestId,
    contractId: contract.id,
    scopeId: scope.id,
    reportId: report.id,
    termsId: terms.id,
    sourceProposalId: extraction.proposals[0]!.id,
  };
}
