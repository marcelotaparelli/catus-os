<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { idempotentPost } from './ui/post';
  import { dayText } from '../shared/domain';
  import type { Snapshot, WorkRequest } from '../shared/domain';
  import UnitField from './ui/UnitField.svelte';
  import type {
    Contract,
    ScopeItem,
    ScopeVersion,
    CommercialSnapshot,
    CommercialPolicy,
  } from '../shared/commercial';
  import { currencies } from '../shared/commercial';
  let {
    api,
    data,
    role,
    userId,
    onChanged,
    members = [],
    query,
  }: {
    api: <T>(
      path: string,
      method?: string,
      body?: unknown,
      key?: string,
    ) => Promise<T>;
    data: Snapshot;
    role: string;
    userId: string;
    onChanged: () => Promise<void>;
    members?: { id: string; name: string }[];
    /** Deep link from a recommendation: opens the scope or the demand it names. */
    query?: URLSearchParams;
  } = $props();
  // Fixed-length UTC timestamp (database values carry a variable number of
  // fractional digits); the full value stays in the datetime attribute.
  function when(iso: string) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? iso
      : `${dayText(iso)} ${d.toISOString().slice(11, 16)} UTC`;
  }
  // Display-only names; identity and authority remain server-side.
  function who(id: string | null | undefined) {
    if (!id) return 'Sistema';
    return members.find((m) => m.id === id)?.name ?? id;
  }
  function origin(item: {
    origin_request_id: string | null;
    origin_interaction_id: string | null;
  }) {
    if (item.origin_request_id)
      return (
        'Solicitação: ' +
        (data.requests.find((r) => r.id === item.origin_request_id)?.title ??
          item.origin_request_id)
      );
    const i = data.interactions.find(
      (x) => x.id === item.origin_interaction_id,
    );
    return i
      ? 'Atendimento: ' + i.summary.slice(0, 120)
      : (item.origin_interaction_id ?? 'Não informada');
  }
  let view = $state<CommercialSnapshot>({
    contracts: [],
    scopes: [],
    changes: [],
    policy: null,
    events: [],
  });
  let busy = $state(false),
    loaded = $state(false),
    error = $state(''),
    info = $state('');
  let projectId = $state(''),
    contractTitle = $state(''),
    kind = $state('fixed_price'),
    currency = $state('BRL'),
    validFrom = $state(''),
    validUntil = $state(''),
    reference = $state('');
  let policyManager = $state(true),
    policyAdmin = $state(true);
  let selectedId = $state(''),
    scopeProject = $state(''),
    scopeContract = $state(''),
    scopeTitle = $state('');
  let draftItems = $state<ScopeItem[]>([]),
    editingId = $state(''),
    editingVersion = $state(0);
  let decisionReason = $state(''),
    changeReason = $state(''),
    changeImpact = $state('');
  let coverageRequest = $state(''),
    coverageItem = $state('');
  let selected = $derived(view.scopes.find((s) => s.id === selectedId));
  let decisionMissing = $state(false),
    decisionInput = $state<HTMLTextAreaElement>(),
    detail = $state<HTMLElement>();
  let linkChoice = $state<Record<string, string>>({});
  let awaiting = $derived(view.scopes.filter((s) => s.state === 'submitted'));
  const projectOf = (r: WorkRequest) =>
    data.interactions.find((i) => i.id === r.interaction_id)?.project_id;
  // Open demands with no approved scope item, each with what it can be linked to.
  let uncovered = $derived(
    data.requests
      .filter((r) => r.commercial_coverage !== 'covered' && r.status !== 'done')
      .map((r) => ({
        request: r,
        project: data.projects.find((p) => p.id === projectOf(r))?.name,
        items: view.scopes
          .filter(
            (s) => s.state === 'approved' && s.project_id === projectOf(r),
          )
          .flatMap((s) =>
            s.items.map((item) => ({
              id: item.id ?? '',
              label: `V${s.number} · ${item.description}`,
            })),
          ),
      })),
  );
  /** A single candidate is suggested, never saved: the person still confirms it. */
  const chosenItem = (id: string, items: { id: string }[]) =>
    linkChoice[id] ?? (items.length === 1 ? items[0]!.id : '');
  let focusDetail = $state(false);
  function openScope(id: string) {
    selectedId = id;
    decisionMissing = false;
    focusDetail = true;
  }
  // A deep link arrives before the data: the detail may only exist after the first load.
  $effect(() => {
    if (!focusDetail || !detail) return;
    detail.scrollIntoView({ block: 'start' });
    detail.focus({ preventScroll: true });
    focusDetail = false;
  });
  // Named demand: its card when uncovered, otherwise the coverage form. The card only
  // exists after the first load, and the frame wait lets the route's own scroll finish.
  let targetDemand = $state(''),
    pendingDemand = $state('');
  $effect(() => {
    const scope = query?.get('escopo'),
      demand = query?.get('demanda');
    untrack(() => {
      if (scope) openScope(scope);
      if (demand) pendingDemand = demand;
    });
  });
  $effect(() => {
    const demand = pendingDemand;
    if (!demand || !loaded) return;
    untrack(() => {
      pendingDemand = '';
      if (!data.requests.some((r) => r.id === demand)) {
        targetDemand = coverageRequest = '';
        error = 'A demanda deste link não foi encontrada nesta organização.';
        return;
      }
      targetDemand = coverageRequest = demand;
      coverageItem = '';
      requestAnimationFrame(() => {
        const card = document.getElementById(`link-${demand}`),
          form = document.getElementById('coverage-demand');
        (card ?? form)?.scrollIntoView({ block: 'center' });
        (card ?? form)?.focus({ preventScroll: true });
      });
    });
  });
  let canPrepare = $derived(role !== 'developer');
  let canDecide = $derived(
    (role === 'manager' || role === 'administrator') &&
      !!view.policy?.approval_roles.includes(role),
  );
  // Orientation only, derived from data already loaded; the server still enforces every rule.
  let nextStep = $derived.by(() => {
    if (!view.policy)
      return role === 'administrator'
        ? 'Defina as alçadas comerciais para liberar decisões de escopo.'
        : 'Aguardando o administrador definir as alçadas comerciais; decisões de escopo bloqueadas.';
    if (!view.contracts.length)
      return canPrepare
        ? 'Cadastre o primeiro contrato do projeto.'
        : 'Nenhum contrato registrado.';
    if (!view.contracts.some((c) => c.state === 'active'))
      return 'Gestor ou administrador deve registrar um contrato como ativo.';
    if (!view.scopes.length)
      return canPrepare
        ? 'Prepare o escopo inicial do contrato ativo.'
        : 'Aguardando a preparação do escopo inicial.';
    const submitted = view.scopes.filter((s) => s.state === 'submitted').length;
    if (submitted)
      return `${submitted} ${submitted === 1 ? 'versão de escopo aguarda' : 'versões de escopo aguardam'} decisão de gestor/administrador com alçada.`;
    const drafts = view.scopes.filter((s) => s.state === 'draft').length;
    if (drafts)
      return `${drafts} ${drafts === 1 ? 'rascunho de escopo a submeter' : 'rascunhos de escopo a submeter'}.`;
    if (view.scopes.some((s) => s.state === 'approved'))
      return canPrepare
        ? 'Vincule as demandas aos itens aprovados em “Demandas sem cobertura”.'
        : 'Escopo aprovado; a cobertura das demandas é feita por PO, gestor ou administrador.';
    return 'Sem pendências comerciais.';
  });
  const contractStates: Record<string, string> = {
    draft: 'Rascunho',
    active: 'Ativo',
    closed: 'Encerrado',
  };
  const labels: Record<string, string> = {
    draft: 'Rascunho',
    submitted: 'Submetido',
    approved: 'Aprovado',
    rejected: 'Rejeitado',
    superseded: 'Substituído',
    pending: 'Pendente',
  };
  const post = untrack(() => idempotentPost(api));
  async function refresh() {
    view = await api<CommercialSnapshot>('commercial');
  }
  async function run(fn: () => Promise<void>) {
    if (busy) return;
    busy = true;
    error = '';
    info = '';
    try {
      await fn();
      await refresh();
      await onChanged();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Falha na operação';
    } finally {
      busy = false;
      loaded = true;
    }
  }
  onMount(() => {
    void run(async () => {});
  });
  function clean(i: ScopeItem): ScopeItem {
    return {
      description: i.description,
      deliverables: i.deliverables,
      exclusions: i.exclusions,
      acceptance_criteria: i.acceptance_criteria,
      dependencies: i.dependencies,
      origin_interaction_id: i.origin_interaction_id,
      origin_request_id: i.origin_request_id,
    };
  }
  function blank(): ScopeItem {
    return {
      description: '',
      deliverables: '',
      exclusions: '',
      acceptance_criteria: '',
      dependencies: '',
      origin_interaction_id: null,
      origin_request_id: null,
    };
  }
  function edit(s: ScopeVersion) {
    editingId = s.id;
    editingVersion = s.version;
    scopeProject = s.project_id;
    scopeContract = s.contract_id;
    scopeTitle = s.title;
    draftItems = s.items.map(clean);
  }
  function newDraft() {
    editingId = '';
    editingVersion = 0;
    scopeProject = '';
    scopeContract = '';
    scopeTitle = '';
    draftItems = [blank()];
  }
  async function saveScope() {
    const body = {
      contract_id: scopeContract,
      title: scopeTitle,
      items: draftItems.map(clean),
    };
    const s = editingId
      ? await api<ScopeVersion>('scopes/' + editingId, 'PATCH', {
          ...body,
          version: editingVersion,
        })
      : await post<ScopeVersion>('scopes', {
          ...body,
          project_id: scopeProject,
        });
    selectedId = s.id;
    editingId = '';
    draftItems = [];
    info = 'Rascunho salvo; ainda sem aprovação comercial.';
  }
  /** Says what is missing instead of leaving the decision disabled. */
  function decide(decision: string) {
    decisionMissing = !decisionReason.trim();
    if (decisionMissing) {
      decisionInput?.focus();
      return;
    }
    void run(async () => {
      if (!selected) return;
      await post('scopes/' + selected.id + '/decide', {
        version: selected.version,
        decision,
        reason: decisionReason,
      });
      decisionReason = '';
      info = 'Decisão humana registrada.';
    });
  }
  function linkDemand(r: WorkRequest, item: string) {
    void run(async () => {
      await post('requests/' + r.id + '/coverage', {
        version: r.version,
        scope_item_id: item,
      });
      info = `“${r.title}” coberta; o estado operacional foi preservado.`;
    });
  }
  async function change() {
    if (!selected) return;
    const c = await post<{ scope: ScopeVersion }>('change-requests', {
      base_scope_id: selected.id,
      version: selected.version,
      reason: changeReason,
      impact: changeImpact,
    });
    selectedId = c.scope.id;
    edit(c.scope);
    changeReason = changeImpact = '';
    info = 'Nova versão em rascunho. A versão aprovada não foi modificada.';
  }
  function currentRequest(): WorkRequest | undefined {
    return data.requests.find((r) => r.id === coverageRequest);
  }
  async function link() {
    const r = currentRequest();
    if (!r) return;
    await post('requests/' + r.id + '/coverage', {
      version: r.version,
      scope_item_id: coverageItem || null,
    });
    info = 'Cobertura revisada; o estado operacional foi preservado.';
  }
  async function policy() {
    const p = await api<CommercialPolicy>('commercial/policy', 'POST', {
      version: view.policy?.version ?? 0,
      approval_roles: [
        ...(policyManager ? ['manager'] : []),
        ...(policyAdmin ? ['administrator'] : []),
      ],
    });
    info =
      'Política v' +
      p.version +
      ' registrada; preparadores nunca decidem o próprio escopo.';
  }
</script>

<section class="panel commercial" aria-label="Controle comercial">
  <div class="section-heading">
    <h2>Contratos e escopos</h2>
    <button class="secondary" disabled={busy} onclick={() => void run(refresh)}
      >Atualizar comercial</button
    >
  </div>
  <p class="muted lead">
    Aprovação operacional e estado “Pronta” não autorizam escopo ou contrato.
    Sem cobertura vigente, a demanda permanece pendente de análise comercial.
  </p>
  <p class="next-step"><strong>Próximo passo:</strong> {nextStep}</p>
  {#if error}<p role="alert" class="error">{error}</p>{/if}{#if info}<p
      role="status"
    >
      {info}
    </p>{/if}
  {#if role === 'administrator'}<details class="m3-policy">
      <summary>Configurar alçadas comerciais</summary>
      <p class="muted">
        Política atual: {view.policy?.approval_roles.join(', ') ??
          'nenhuma; decisões bloqueadas'} · versão {view.policy?.version ?? 0}.
        O servidor impede autoaprovação de qualquer preparador.
      </p>
      <form
        class="policy-form"
        onsubmit={(e) => {
          e.preventDefault();
          void run(policy);
        }}
      >
        <fieldset class="check-group">
          <legend>Quem pode decidir escopos</legend>
          <label class="check-option"
            ><input type="checkbox" bind:checked={policyManager} /> Gestor pode decidir</label
          ><label class="check-option"
            ><input type="checkbox" bind:checked={policyAdmin} /> Administrador pode
            decidir</label
          >
        </fieldset>
        <button disabled={busy || (!policyManager && !policyAdmin)}
          >Salvar alçadas</button
        >
      </form>
    </details>{/if}
  <!-- Nothing renders until the data arrives, so loading never pushes content down (CLS). -->
  {#if !loaded}<p class="empty-line">Carregando contratos e escopos…</p>{:else}
    {#if awaiting.length}<div
        class="m3-block"
        role="group"
        aria-labelledby="m3-awaiting"
      >
        <h3 id="m3-awaiting">
          Aguardando decisão <span class="count">{awaiting.length}</span>
        </h3>
        {#each awaiting as s}<article class="queue-card">
            <div class="queue-body">
              <p class="eyebrow">
                {data.projects.find((p) => p.id === s.project_id)?.name}
              </p>
              <h4>V{s.number} · {s.title}</h4>
              <p>
                {s.items.length}
                {s.items.length === 1 ? 'item' : 'itens'} · preparado por {who(
                  s.created_by,
                )}
              </p>
            </div>
            <div class="actions">
              <button
                class={canDecide ? '' : 'secondary'}
                aria-label={`${canDecide ? 'Revisar e decidir' : 'Ver'} V${s.number} de ${s.title}`}
                onclick={() => openScope(s.id)}
                >{canDecide ? 'Revisar e decidir' : 'Ver'}</button
              >
            </div>
          </article>{/each}
      </div>{/if}
    {#if canPrepare && uncovered.length}<div
        class="m3-block"
        role="group"
        aria-labelledby="m3-uncovered"
      >
        <h3 id="m3-uncovered">
          Demandas sem cobertura <span class="count">{uncovered.length}</span>
        </h3>
        {#each uncovered as u}<article
            class="queue-card"
            class:targeted={targetDemand === u.request.id}
            id={`link-${u.request.id}`}
            tabindex="-1"
            aria-current={targetDemand === u.request.id ? 'true' : undefined}
          >
            <div class="queue-body">
              <p class="eyebrow">{u.project ?? 'Projeto indisponível'}</p>
              <h4>{u.request.title}</h4>
              {#if !u.items.length}<p class="muted">
                  Este projeto ainda não tem item de escopo aprovado.
                </p>{/if}
            </div>
            {#if u.items.length}<div class="link-row">
                <label
                  >Item de escopo<select
                    value={chosenItem(u.request.id, u.items)}
                    aria-label={`Item de escopo para ${u.request.title}`}
                    onchange={(e) =>
                      (linkChoice[u.request.id] = e.currentTarget.value)}
                    ><option value="">Selecione</option
                    >{#each u.items as item}<option value={item.id}
                        >{item.label}</option
                      >{/each}</select
                  ></label
                >
                <button
                  disabled={busy || !chosenItem(u.request.id, u.items)}
                  aria-label={`Vincular ${u.request.title}`}
                  onclick={() =>
                    linkDemand(u.request, chosenItem(u.request.id, u.items))}
                  >Vincular</button
                >
              </div>{/if}
          </article>{/each}
      </div>{/if}
    <div class="m3-block" role="group" aria-labelledby="m3-contracts">
      <h3 id="m3-contracts">
        Contratos <span class="count">{view.contracts.length}</span>
      </h3>
      {#if canPrepare}<details>
          <summary>Cadastrar contrato</summary>
          <form
            class="commercial-form"
            onsubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const p = data.projects.find((p) => p.id === projectId);
                if (!p) return;
                await post('contracts', {
                  project_id: p.id,
                  client_id: p.client_id,
                  title: contractTitle,
                  kind,
                  currency,
                  valid_from: validFrom,
                  valid_until: validUntil,
                  document_reference: reference,
                });
                contractTitle = reference = '';
                info =
                  'Contrato registrado como rascunho; ativação exige gestor/admin e documento externo.';
              });
            }}
          >
            <label
              >Projeto contratual<select bind:value={projectId} required
                ><option value="">Selecione</option
                >{#each data.projects as p}<option value={p.id}>{p.name}</option
                  >{/each}</select
              ></label
            >
            <label
              >Título do contrato<input
                bind:value={contractTitle}
                maxlength="200"
                required
              /></label
            >
            <label
              >Tipo contratual<select bind:value={kind}
                ><option value="fixed_price">Projeto de preço fechado</option
                ><option value="retainer">Retainer / banco de horas</option
                ></select
              ></label
            >
            <label
              >Moeda<select bind:value={currency}
                >{#each currencies as c}<option value={c}>{c}</option
                  >{/each}</select
              ></label
            >
            <UnitField
              label="Vigência inicial (UTC)"
              kind="date"
              bind:value={validFrom}
            /><UnitField
              label="Vigência final (UTC)"
              kind="date"
              bind:value={validUntil}
              min={validFrom}
            />
            <label class="span"
              >Referência documental<input
                bind:value={reference}
                maxlength="2000"
                required
                placeholder="Identificador do documento externo autorizado"
              /></label
            >
            <p class="muted span">
              Referência textual, sem upload ou consulta externa. Nenhum valor
              financeiro é inferido.
            </p>
            <div class="actions">
              <button disabled={busy}>Registrar contrato</button>
            </div>
          </form>
        </details>{/if}
      <div class="cards m3-cards">
        {#each view.contracts as c}<article class="request">
            <div class="card-top">
              <h4>{c.title}</h4>
              <span class="status" data-status={c.state}
                >{contractStates[c.state] ?? c.state}</span
              >
            </div>
            <p>
              {data.projects.find((p) => p.id === c.project_id)?.name} · {c.kind ===
              'fixed_price'
                ? 'Preço fechado'
                : 'Retainer / banco de horas'} · {c.currency}
            </p>
            <p>
              Vigência {dayText(c.valid_from)} a {dayText(c.valid_until)} UTC · revisão
              {c.version}
            </p>
            <p class="description">Documento: {c.document_reference}</p>
            {#if ['manager', 'administrator'].includes(role) && c.state !== 'closed'}<button
                class="secondary"
                disabled={busy}
                onclick={() =>
                  void run(async () => {
                    await api<Contract>('contracts/' + c.id, 'PATCH', {
                      version: c.version,
                      state: c.state === 'draft' ? 'active' : 'closed',
                    });
                  })}
                >{c.state === 'draft'
                  ? 'Registrar contrato como ativo'
                  : 'Encerrar contrato'}</button
              >{/if}
          </article>{:else}<p class="empty-line">
            Nenhum contrato registrado.
          </p>{/each}
      </div>
    </div>
    <div class="m3-block" role="group" aria-labelledby="m3-scopes">
      <div class="block-head">
        <h3 id="m3-scopes">
          Escopos <span class="count">{view.scopes.length}</span>
        </h3>
        {#if canPrepare}<button
            class="secondary"
            disabled={busy}
            onclick={newDraft}>Preparar escopo inicial</button
          >{/if}
      </div>
      {#if draftItems.length && canPrepare}<form
          aria-label="Preparar versão de escopo"
          class="commercial-form"
          onsubmit={(e) => {
            e.preventDefault();
            void run(saveScope);
          }}
        >
          <h3>{editingId ? 'Editar rascunho' : 'Escopo inicial'}</h3>
          <label
            >Projeto do escopo<select
              bind:value={scopeProject}
              required
              disabled={!!editingId}
              onchange={() => (scopeContract = '')}
              ><option value="">Selecione</option
              >{#each data.projects as p}<option value={p.id}>{p.name}</option
                >{/each}</select
            ></label
          >
          <label
            >Contrato do escopo<select bind:value={scopeContract} required
              ><option value="">Selecione</option
              >{#each view.contracts.filter((c) => c.project_id === scopeProject && c.state !== 'closed') as c}<option
                  value={c.id}>{c.title}</option
                >{/each}</select
            ></label
          >
          <label class="span"
            >Título da versão<input
              bind:value={scopeTitle}
              maxlength="200"
              required
            /></label
          >
          {#each draftItems as item, i}<fieldset>
              <legend>Item {i + 1}</legend>
              <label
                >Descrição do item<textarea
                  bind:value={item.description}
                  maxlength="2000"
                  required
                ></textarea></label
              ><label
                >Entregáveis<textarea
                  bind:value={item.deliverables}
                  maxlength="2000"
                  required
                ></textarea></label
              ><label
                >Exclusões<textarea
                  bind:value={item.exclusions}
                  maxlength="2000"
                  required
                ></textarea></label
              ><label
                >Critérios de aceite contratual<textarea
                  bind:value={item.acceptance_criteria}
                  maxlength="2000"
                  required
                ></textarea></label
              ><label
                >Dependências<textarea
                  bind:value={item.dependencies}
                  maxlength="2000"
                  required
                ></textarea></label
              >
              <label
                >Atendimento de origem comercial<select
                  bind:value={item.origin_interaction_id}
                  ><option value={null}>Usar somente demanda</option
                  >{#each data.interactions.filter((x) => x.project_id === scopeProject) as a}<option
                      value={a.id}>{a.summary.slice(0, 80)}</option
                    >{/each}</select
                ></label
              >
              <label
                >Demanda de origem comercial<select
                  bind:value={item.origin_request_id}
                  ><option value={null}>Usar somente atendimento</option
                  >{#each data.requests.filter((r) => data.interactions.find((a) => a.id === r.interaction_id)?.project_id === scopeProject && (!item.origin_interaction_id || r.interaction_id === item.origin_interaction_id)) as r}<option
                      value={r.id}>{r.title}</option
                    >{/each}</select
                ></label
              >
              <button
                type="button"
                class="secondary"
                disabled={draftItems.length === 1 || busy}
                onclick={() =>
                  (draftItems = draftItems.filter((_, j) => j !== i))}
                >Remover item {i + 1}</button
              >
            </fieldset>{/each}
          <div class="actions">
            <button
              type="button"
              class="secondary"
              disabled={busy || draftItems.length >= 20}
              onclick={() => (draftItems = [...draftItems, blank()])}
              >Adicionar item de escopo</button
            ><button disabled={busy}>Salvar rascunho de escopo</button><button
              type="button"
              class="secondary"
              onclick={() => {
                draftItems = [];
                editingId = '';
              }}>Cancelar edição</button
            >
          </div>
        </form>{/if}
      <label class="field-narrow"
        >Versão de escopo<select bind:value={selectedId}
          ><option value="">Selecione</option>{#each view.scopes as s}<option
              value={s.id}
              >{data.projects.find((p) => p.id === s.project_id)?.name} · V{s.number}
              · {s.title} · {labels[s.state]}</option
            >{/each}</select
        ></label
      >
      {#if selected}<div
          class="scope-detail"
          aria-label="Detalhe do escopo"
          role="group"
          tabindex="-1"
          bind:this={detail}
        >
          <h3>V{selected.number} · {selected.title}</h3>
          <p>
            Estado comercial: <span class="status" data-status={selected.state}
              >{labels[selected.state]}</span
            >
            · revisão {selected.version}
          </p>
          <p class="muted">
            Preparador: {who(selected.created_by)} · origem da versão: {selected.previous_id ??
              'inicial'}
          </p>
          {#each selected.items as item, i}<article class="request">
              <h4>Item {i + 1} · {item.description}</h4>
              <dl>
                <dt>Entregáveis</dt>
                <dd>{item.deliverables}</dd>
                <dt>Exclusões</dt>
                <dd>{item.exclusions}</dd>
                <dt>Critérios</dt>
                <dd>{item.acceptance_criteria}</dd>
                <dt>Dependências</dt>
                <dd>{item.dependencies}</dd>
                <dt>Origem</dt>
                <dd>{origin(item)}</dd>
              </dl>
            </article>{/each}
          {#if selected.decision}<p>
              Decisão: {labels[selected.decision.decision]} por {who(
                selected.decision.actor_user_id,
              )} ({selected.decision.actor_role}), política v{selected.decision
                .policy_version}, revisão {selected.decision.scope_version}, em
              <time datetime={selected.decision.decided_at}
                >{when(selected.decision.decided_at)}</time
              >. {selected.decision.reason}
            </p>{/if}
          {#if canPrepare && selected.state === 'draft'}<button
              class="secondary"
              disabled={busy}
              onclick={() => selected && edit(selected)}
              >Editar rascunho selecionado</button
            ><button
              disabled={busy}
              onclick={() =>
                void run(async () => {
                  if (selected)
                    await post('scopes/' + selected.id + '/submit', {
                      version: selected.version,
                    });
                })}>Submeter escopo</button
            >{/if}
          {#if canPrepare && selected.state === 'rejected' && !view.changes.some((c) => c.proposed_scope_id === selected?.id)}<button
              class="secondary"
              disabled={busy}
              onclick={() =>
                void run(async () => {
                  if (!selected) return;
                  const s = await post<ScopeVersion>(
                    'scopes/' + selected.id + '/revisions',
                    { version: selected.version },
                  );
                  selectedId = s.id;
                  edit(s);
                })}>Preparar revisão da rejeitada</button
            >{/if}
          {#if selected.state === 'submitted'}
            {#if !canDecide}<p class="muted">
                Somente gestor/admin com alçada explícita e sem participação na
                preparação pode decidir.
              </p>{:else if selected.created_by === userId || selected.submitted_by === userId}<p
                class="queue-blocked"
              >
                Você participou da preparação deste escopo. Outra pessoa com
                alçada precisa decidir.
              </p>{:else}<label
                >Justificativa da decisão<textarea
                  bind:this={decisionInput}
                  bind:value={decisionReason}
                  maxlength="2000"
                  required
                  aria-invalid={decisionMissing && !decisionReason.trim()
                    ? 'true'
                    : undefined}
                  oninput={() => (decisionMissing = false)}
                ></textarea></label
              >
              {#if decisionMissing}<small class="field-error" role="alert"
                  >Escreva a justificativa para registrar a decisão.</small
                >{/if}
              <div class="actions">
                <button disabled={busy} onclick={() => decide('approved')}
                  >Aprovar escopo</button
                ><button
                  class="secondary"
                  disabled={busy}
                  onclick={() => decide('rejected')}>Rejeitar escopo</button
                >
              </div>{/if}{/if}
          {#if selected.state === 'rejected' && view.changes.some((c) => c.proposed_scope_id === selected?.id)}<p
            >
              Change request rejeitado. Selecione a versão atualmente aprovada
              para preparar outro change request.
            </p>{/if}
          {#if canPrepare && selected.state === 'approved'}<form
              aria-label="Preparar change request"
              onsubmit={(e) => {
                e.preventDefault();
                void run(change);
              }}
            >
              <h4>Change request → nova versão</h4>
              <label
                >Motivo da alteração<textarea
                  bind:value={changeReason}
                  required
                  maxlength="2000"
                ></textarea></label
              ><label
                >Impacto descritivo<textarea
                  bind:value={changeImpact}
                  required
                  maxlength="4000"
                ></textarea></label
              ><button disabled={busy}>Criar change request</button>
            </form>{/if}
        </div>{/if}
    </div>
    {#if canPrepare}<form
        class="m3-block coverage-form"
        aria-label="Revisar cobertura comercial"
        onsubmit={(e) => {
          e.preventDefault();
          void run(link);
        }}
      >
        <h3>Alterar ou remover cobertura</h3>
        <label class="field-narrow"
          >Demanda para cobertura<select
            id="coverage-demand"
            bind:value={coverageRequest}
            onchange={() => (coverageItem = '')}
            required
            ><option value="">Selecione</option
            >{#each data.requests as r}<option value={r.id}>{r.title}</option
              >{/each}</select
          ></label
        ><label class="field-narrow"
          >Item de escopo aprovado<select bind:value={coverageItem}
            ><option value="">Sem cobertura / remover vínculo</option
            >{#each view.scopes.filter((s) => s.state === 'approved' && s.project_id === data.interactions.find((i) => i.id === currentRequest()?.interaction_id)?.project_id) as s}{#each s.items as item}<option
                  value={item.id}>V{s.number} · {item.description}</option
                >{/each}{/each}</select
          ></label
        ><button disabled={busy || !coverageRequest}>Confirmar cobertura</button
        >
      </form>{/if}
    <details class="m3-block">
      <summary>Change requests e histórico comercial</summary
      >{#each view.changes as c}<p>
          {c.reason} · {c.impact} · {labels[c.state]} · base {c.base_scope_id} → versão
          {c.proposed_scope_id}
        </p>{:else}<p>Nenhum change request.</p>{/each}
      <p class="muted">
        Até 200 eventos recentes. Autoria, competência e snapshots preservados.
      </p>
      {#each view.events as e}<details>
          <summary
            >{e.entity_type} · {e.action} · {who(e.actor_user_id)} ({e.actor_role})
            · <time datetime={e.created_at}>{when(e.created_at)}</time></summary
          >
          <!-- svelte-ignore a11y_no_noninteractive_tabindex (scrollable region must be keyboard reachable, WCAG 2.1.1) -->
          <pre tabindex="0">{JSON.stringify(
              { antes: e.before_data, depois: e.after_data },
              null,
              2,
            )}</pre>
        </details>{/each}
    </details>
  {/if}
</section>
