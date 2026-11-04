/**
 * Synthetic e-commerce agency, built only through the public API with real sessions and
 * independent approvals, on disposable databases. No SQL, no bypass, no real data.
 * EXPECTED below was worked out by hand from docs/ECONOMICS.md (see docs/VALUE_FIRST.md):
 * it is the independent check against the engine, not a copy of its output.
 */
export type Actor = 'admin' | 'manager' | 'po' | 'dev' | 'dev2';
export type Call = <T = any>(
  who: Actor,
  path: string,
  method?: string,
  body?: unknown,
) => Promise<T>;
export const addDays = (base: Date, days: number) =>
  new Date(base.getTime() + days * 86400000).toISOString().slice(0, 10);
const reason = 'Conferência independente do cenário sintético';

export async function buildEcommerceScenario(
  call: Call,
  people: Record<Actor, string>,
  now = new Date(),
) {
  const period = { from: addDays(now, -30), until: addDays(now, 30) },
    contractPeriod = { from: addDays(now, -120), until: addDays(now, 240) },
    source = (s: string) => `SINTÉTICO · ${s}`;
  await call('admin', 'commercial/policy', 'POST', {
    version: 0,
    approval_roles: ['manager', 'administrator'],
  });
  async function record(
    kind: string,
    project: string | null,
    payload: unknown,
    who: Actor = 'manager',
    decider: Actor = 'admin',
    range = period,
  ) {
    const r = await call(who, 'economics/records', 'POST', {
      kind,
      project_id: project,
      currency: 'BRL',
      valid_from: range.from,
      valid_until: range.until,
      source: source(kind),
      payload,
      previous_id: null,
    });
    await call(decider, `economics/records/${r.id}/decide`, 'POST', {
      revision: r.revision,
      decision: 'approved',
      reason,
      cost_role: null,
    });
    return r as { id: string; revision: number };
  }
  // Premises and rates for the whole organization.
  await record(
    'config',
    null,
    {
      tax_bps: 800,
      commission_bps: 200,
      overhead_rule: 'per_labor_minute',
      overhead_minor_per_hour: '3000',
      weekdays: [1, 2, 3, 4, 5],
      minutes_per_day: 480,
      holidays: [],
    },
    'manager',
    'admin',
    contractPeriod,
  );
  for (const [who, rate] of [
    [people.dev, '12000'],
    [people.dev2, '9000'],
  ] as const)
    await record(
      'rate',
      null,
      { user_id: who, role: null, minor_per_hour: rate },
      'manager',
      'admin',
      contractPeriod,
    );

  async function project(
    client: { id: string },
    name: string,
    kind: 'fixed_price' | 'retainer',
    items: string[],
    approve = true,
  ) {
    const p = await call('po', 'projects', 'POST', {
      client_id: client.id,
      name,
    });
    const interaction = await call('po', 'interactions', 'POST', {
      project_id: p.id,
      kind: 'meeting',
      summary: `Reunião sintética de alinhamento: ${name}`,
      occurred_at: now.toISOString(),
    });
    const contract = await call('po', 'contracts', 'POST', {
      project_id: p.id,
      client_id: client.id,
      title: `Contrato ${name}`,
      kind,
      currency: 'BRL',
      valid_from: contractPeriod.from,
      valid_until: contractPeriod.until,
      document_reference: `SINTETICO-${name.slice(0, 12)}`,
    });
    await call('manager', `contracts/${contract.id}`, 'PATCH', {
      version: contract.version,
      state: 'active',
    });
    const scope = await call('po', 'scopes', 'POST', {
      project_id: p.id,
      contract_id: contract.id,
      title: `Escopo ${name}`,
      items: items.map((description) => ({
        description,
        deliverables: description,
        exclusions: 'Integrações não listadas',
        acceptance_criteria: 'Aceite sintético registrado',
        dependencies: 'Acesso ao ambiente sintético',
        origin_interaction_id: interaction.id,
        origin_request_id: null,
      })),
    });
    const submitted = await call('po', `scopes/${scope.id}/submit`, 'POST', {
      version: scope.version,
    });
    if (approve)
      await call('manager', `scopes/${scope.id}/decide`, 'POST', {
        version: submitted.version,
        decision: 'approved',
        reason,
      });
    return {
      id: p.id as string,
      interaction: interaction.id as string,
      contract: contract.id as string,
      scope: scope.id as string,
      items: (scope.items as { id: string }[]).map((i) => i.id),
    };
  }
  async function demand(
    p: { interaction: string },
    title: string,
    owner: string,
    nextAction: string,
    opts: { item?: string; status?: string[] } = {},
  ) {
    const created = await call('po', 'requests', 'POST', {
      interaction_id: p.interaction,
      title,
      description: `Demanda sintética: ${title}`,
      owner_user_id: owner,
      next_action: nextAction,
    });
    let version: number = created.version;
    if (opts.item)
      version = (
        await call('po', `requests/${created.id}/coverage`, 'POST', {
          version,
          scope_item_id: opts.item,
        })
      ).version;
    for (const status of opts.status ?? [])
      version = (
        await call('po', `requests/${created.id}`, 'PATCH', {
          status,
          owner_user_id: owner,
          next_action: nextAction,
          version,
          ...(status === 'blocked'
            ? { blocked_reason: nextAction, waiting_on: 'client' }
            : {}),
        })
      ).version;
    return created.id as string;
  }
  const terms = (
    p: { contract: string; scope: string },
    amount: string,
    extra: Record<string, unknown> = {},
  ) => ({
    contract_id: p.contract,
    scope_id: p.scope,
    amount_minor: amount,
    recognition_rule: 'none',
    recognized_minor: null,
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
    ...extra,
  });
  const estimate = (
    p: string,
    termsId: string,
    request: string,
    user: string,
    planned: number,
    remaining: number,
    expected: string,
  ) =>
    record(
      'estimate',
      p,
      {
        terms_id: termsId,
        request_id: request,
        user_id: user,
        planned_minutes: planned,
        remaining_minutes: remaining,
        expected_on: expected,
      },
      'po',
      'manager',
    );
  /** One entry per (minutes, days ago); entries are decided unless `pending`. */
  async function hours(
    who: 'dev' | 'dev2',
    p: string,
    request: string,
    entries: [minutes: number, daysAgo: number][],
    pending = false,
  ) {
    for (const [minutes, daysAgo] of entries) {
      const t = await call(who, 'economics/times', 'POST', {
        project_id: p,
        request_id: request,
        work_date: addDays(now, -daysAgo),
        minutes,
        comment: `Trabalho sintético ${minutes} min há ${daysAgo} dias`,
        replaces_id: null,
      });
      if (!pending)
        await call('manager', `economics/times/${t.id}/action`, 'POST', {
          expected_state: 'pending',
          action: 'approved',
          reason,
          cost_role: null,
        });
    }
  }
  const client = await call('po', 'clients', 'POST', {
    name: 'Aurora Moda (sintético)',
  });

  // A · Fixed price, margin still positive but consuming more hours than planned.
  const a = await project(client, 'Loja Aurora: novo checkout', 'fixed_price', [
    'Checkout com Pix',
    'Cupons de desconto',
  ]);
  const aPix = await demand(
    a,
    'Checkout com Pix',
    people.dev,
    'Concluir conciliação do Pix',
    { item: a.items[0]!, status: ['triage', 'ready', 'in_progress'] },
  );
  const aCupom = await demand(
    a,
    'Cupons de desconto',
    people.dev2,
    'Finalizar regras de cupom',
    { item: a.items[1]!, status: ['triage', 'ready', 'in_progress'] },
  );
  const aTerms = await record(
    'terms',
    a.id,
    terms(a, '1500000', {
      recognition_rule: 'manual',
      recognized_minor: '900000',
    }),
  );
  await estimate(
    a.id,
    aTerms.id,
    aPix,
    people.dev,
    1800,
    1200,
    addDays(now, 15),
  );
  await estimate(
    a.id,
    aTerms.id,
    aCupom,
    people.dev2,
    600,
    240,
    addDays(now, -2),
  );
  await record('capacity', a.id, {
    user_id: people.dev,
    available_minutes: 1800,
  });
  await record('capacity', a.id, {
    user_id: people.dev2,
    available_minutes: 600,
  });
  await record('direct_cost', a.id, {
    terms_id: aTerms.id,
    expense_key: 'GATEWAY-PIX-SINTETICO',
    classification: 'external',
    budget_minor: '150000',
    incurred_minor: '100000',
    remaining_minor: '50000',
  });
  await hours('dev', a.id, aPix, [
    [480, 20],
    [480, 19],
    [480, 18],
    [60, 17],
  ]);
  await hours('dev2', a.id, aCupom, [[180, 13]]);

  // B · Retainer already over the included hours, no billable overage: negative margin.
  const b = await project(client, 'Performance e mídia', 'retainer', [
    'Gestão mensal de campanhas',
  ]);
  const bCampanhas = await demand(
    b,
    'Campanhas de performance',
    people.dev2,
    'Rever plano de mídia do período',
    { item: b.items[0]!, status: ['triage', 'ready', 'in_progress'] },
  );
  const bTerms = await record(
    'terms',
    b.id,
    terms(b, '600000', {
      recognition_rule: 'at_period_end',
      included_minutes: 1800,
    }),
  );
  await estimate(
    b.id,
    bTerms.id,
    bCampanhas,
    people.dev2,
    1800,
    600,
    addDays(now, 25),
  );
  await record('capacity', b.id, {
    user_id: people.dev2,
    available_minutes: 1200,
  });
  await hours('dev2', b.id, bCampanhas, [
    [480, 12],
    [480, 11],
    [480, 10],
    [480, 9],
    [360, 8],
  ]);

  // C · Fixed price exactly on plan: positive margin, nothing to do.
  const c = await project(client, 'Integração ERP', 'fixed_price', [
    'Sincronizar pedidos com o ERP',
  ]);
  const cErp = await demand(
    c,
    'Sincronização de pedidos',
    people.dev,
    'Homologar lote de pedidos',
    { item: c.items[0]!, status: ['triage', 'ready', 'in_progress'] },
  );
  const cTerms = await record(
    'terms',
    c.id,
    terms(c, '2000000', {
      recognition_rule: 'manual',
      recognized_minor: '800000',
    }),
  );
  await estimate(
    c.id,
    cTerms.id,
    cErp,
    people.dev,
    3000,
    1800,
    addDays(now, 28),
  );
  await record('capacity', c.id, {
    user_id: people.dev,
    available_minutes: 1800,
  });
  await hours('dev', c.id, cErp, [
    [480, 16],
    [480, 15],
    [240, 14],
  ]);

  // D · Hours awaiting decision, no capacity, blocked and uncovered work: margin unknown.
  const d = await project(client, 'App de fidelidade', 'fixed_price', [
    'Cartão de fidelidade',
  ]);
  const dCartao = await demand(
    d,
    'Cartão de fidelidade',
    people.dev,
    'Publicar build de teste',
    { item: d.items[0]!, status: ['triage', 'ready', 'in_progress'] },
  );
  const dPush = await demand(
    d,
    'Notificações push',
    people.dev,
    'Obter credenciais da loja de aplicativos',
    {
      item: d.items[0]!,
      status: ['triage', 'ready', 'in_progress', 'blocked'],
    },
  );
  const dIndica = await demand(
    d,
    'Programa de indicação',
    people.dev2,
    'Confirmar se está no contrato',
  );
  const dTerms = await record(
    'terms',
    d.id,
    terms(d, '1200000', {
      recognition_rule: 'manual',
      recognized_minor: '300000',
    }),
  );
  await estimate(
    d.id,
    dTerms.id,
    dCartao,
    people.dev,
    1200,
    840,
    addDays(now, 20),
  );
  await hours('dev', d.id, dCartao, [[360, 5]], true);

  // E · Scope still awaiting decision, so no economic base can exist yet.
  const e = await project(
    client,
    'Landing de Black Friday',
    'fixed_price',
    ['Landing da campanha'],
    false,
  );
  const eLanding = await demand(
    e,
    'Landing da campanha',
    people.dev2,
    'Aguardar decisão do escopo',
  );
  return {
    now,
    period,
    client: client.id as string,
    projects: { a: a.id, b: b.id, c: c.id, d: d.id, e: e.id },
    terms: { a: aTerms.id, b: bTerms.id, c: cTerms.id, d: dTerms.id },
    requests: {
      aPix,
      aCupom,
      bCampanhas,
      cErp,
      dCartao,
      dPush,
      dIndica,
      eLanding,
    },
  };
}
export const NAMES = {
  a: 'Loja Aurora: novo checkout',
  b: 'Performance e mídia',
  c: 'Integração ERP',
  d: 'App de fidelidade',
  e: 'Landing de Black Friday',
} as const;
/** Hand-worked values, in centavos and minutes. Derivation in docs/VALUE_FIRST.md. */
export const EXPECTED = {
  a: {
    planned_minutes: 2400,
    approved_minutes: 1680,
    remaining_minutes: 1440,
    hours_variance_minutes: 720,
    contracted_revenue: '1500000',
    recognized_revenue: '900000',
    projected_revenue: '1500000',
    budget_cost: '870000',
    cost_incurred: '511000',
    estimate_to_complete: '398000',
    eac: '1059000',
    cost_variance: '189000',
    projected_margin: '441000',
    projected_margin_bps: '2940',
    realized_cost: '601000',
    realized_margin: '299000',
    realized_margin_bps: '3322',
  },
  b: {
    planned_minutes: 1800,
    approved_minutes: 2280,
    remaining_minutes: 600,
    hours_variance_minutes: 1080,
    contracted_revenue: '600000',
    recognized_revenue: null,
    projected_revenue: '600000',
    budget_cost: '420000',
    cost_incurred: '456000',
    estimate_to_complete: '120000',
    eac: '636000',
    cost_variance: '216000',
    projected_margin: '-36000',
    projected_margin_bps: '-600',
    balance_minutes: -480,
    overage_minutes: 480,
    realized_margin: null,
  },
  c: {
    planned_minutes: 3000,
    approved_minutes: 1200,
    remaining_minutes: 1800,
    hours_variance_minutes: 0,
    contracted_revenue: '2000000',
    recognized_revenue: '800000',
    budget_cost: '950000',
    cost_incurred: '300000',
    estimate_to_complete: '450000',
    eac: '950000',
    cost_variance: '0',
    projected_margin: '1050000',
    projected_margin_bps: '5250',
    realized_cost: '380000',
    realized_margin: '420000',
    realized_margin_bps: '5250',
  },
  /** App de fidelidade while 6h await decision and capacity is undeclared. */
  dIncomplete: {
    planned_minutes: 1200,
    approved_minutes: 0,
    pending_minutes: 360,
    remaining_minutes: 840,
    projected_margin: null,
    projected_margin_bps: null,
    realized_margin: null,
    capacity_minutes: null,
  },
  /** Same project after the 6h are approved and 14h of capacity are declared. */
  dComplete: {
    planned_minutes: 1200,
    approved_minutes: 360,
    pending_minutes: 0,
    remaining_minutes: 840,
    hours_variance_minutes: 0,
    budget_cost: '420000',
    cost_incurred: '90000',
    estimate_to_complete: '210000',
    eac: '420000',
    cost_variance: '0',
    projected_margin: '780000',
    projected_margin_bps: '6500',
  },
} as const;
