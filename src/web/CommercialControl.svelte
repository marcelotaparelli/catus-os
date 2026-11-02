<script lang="ts">
  import { onMount } from 'svelte';
  import type { Snapshot, WorkRequest } from '../shared/domain';
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
  } = $props();
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
  let canPrepare = $derived(role !== 'developer');
  let canDecide = $derived(
    (role === 'manager' || role === 'administrator') &&
      !!view.policy?.approval_roles.includes(role),
  );
  const labels: Record<string, string> = {
    draft: 'Rascunho',
    submitted: 'Submetido',
    approved: 'Aprovado',
    rejected: 'Rejeitado',
    superseded: 'Substituído',
    pending: 'Pendente',
  };
  const attempts = new Map<string, { json: string; key: string }>();
  async function post<T>(path: string, body: unknown): Promise<T> {
    const json = JSON.stringify(body);
    let a = attempts.get(path);
    if (!a || a.json !== json) {
      a = { json, key: crypto.randomUUID() };
      attempts.set(path, a);
    }
    const result = await api<T>(path, 'POST', body, a.key);
    attempts.delete(path);
    return result;
  }
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
  async function decide(decision: string) {
    if (!selected) return;
    await post('scopes/' + selected.id + '/decide', {
      version: selected.version,
      decision,
      reason: decisionReason,
    });
    decisionReason = '';
    info = 'Decisão humana registrada.';
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
    <div>
      <p class="eyebrow">M3 · CONTROLE COMERCIAL</p>
      <h2>Contratos e escopos</h2>
    </div>
    <button class="secondary" disabled={busy} onclick={() => void run(refresh)}
      >Atualizar comercial</button
    >
  </div>
  <p class="muted">
    Aprovação operacional e estado “Pronta” não autorizam escopo ou contrato.
    Sem cobertura vigente, a demanda permanece pendente de análise comercial.
  </p>
  {#if error}<p role="alert" class="error">{error}</p>{/if}{#if info}<p
      role="status"
    >
      {info}
    </p>{/if}
  {#if role === 'administrator'}<details>
      <summary>Configurar alçadas comerciais</summary>
      <p>
        Política atual: {view.policy?.approval_roles.join(', ') ??
          'nenhuma; decisões bloqueadas'} · versão {view.policy?.version ?? 0}.
        O servidor impede autoaprovação de qualquer preparador.
      </p>
      <form
        onsubmit={(e) => {
          e.preventDefault();
          void run(policy);
        }}
      >
        <label
          ><input type="checkbox" bind:checked={policyManager} /> Gestor pode decidir</label
        ><label
          ><input type="checkbox" bind:checked={policyAdmin} /> Administrador pode
          decidir</label
        ><button disabled={busy || (!policyManager && !policyAdmin)}
          >Salvar alçadas</button
        >
      </form>
    </details>{/if}
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
            ><option value="retainer">Retainer / banco de horas</option></select
          ></label
        >
        <label
          >Moeda<select bind:value={currency}
            >{#each currencies as c}<option value={c}>{c}</option
              >{/each}</select
          ></label
        >
        <label
          >Vigência inicial (UTC)<input
            type="date"
            bind:value={validFrom}
            required
          /></label
        ><label
          >Vigência final (UTC)<input
            type="date"
            bind:value={validUntil}
            min={validFrom}
            required
          /></label
        >
        <label
          >Referência documental<input
            bind:value={reference}
            maxlength="2000"
            required
            placeholder="Identificador do documento externo autorizado"
          /></label
        >
        <p class="muted">
          Referência textual, sem upload ou consulta externa. Nenhum valor
          financeiro é inferido.
        </p>
        <button disabled={busy}>Registrar contrato</button>
      </form>
    </details>{/if}
  <div class="cards">
    {#each view.contracts as c}<article class="request">
        <h3>{c.title}</h3>
        <p>
          {data.projects.find((p) => p.id === c.project_id)?.name} · {c.kind ===
          'fixed_price'
            ? 'Preço fechado'
            : 'Retainer / banco de horas'} · {c.currency}
        </p>
        <p>
          {c.valid_from.slice(0, 10)} a {c.valid_until.slice(0, 10)} UTC · {c.state ===
          'active'
            ? 'Ativo'
            : c.state === 'closed'
              ? 'Encerrado'
              : 'Rascunho'} · v{c.version}
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
      </article>{:else}<p>Nenhum contrato registrado.</p>{/each}
  </div>
  {#if canPrepare}<button class="secondary" disabled={busy} onclick={newDraft}
      >Preparar escopo inicial</button
    >{/if}
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
          ><option value="">Selecione</option>{#each data.projects as p}<option
              value={p.id}>{p.name}</option
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
      <label
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
            onclick={() => (draftItems = draftItems.filter((_, j) => j !== i))}
            >Remover item {i + 1}</button
          >
        </fieldset>{/each}
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
    </form>{/if}
  <label
    >Versão de escopo<select bind:value={selectedId}
      ><option value="">Selecione</option>{#each view.scopes as s}<option
          value={s.id}
          >{data.projects.find((p) => p.id === s.project_id)?.name} · V{s.number}
          · {s.title} · {labels[s.state]}</option
        >{/each}</select
    ></label
  >
  {#if selected}<div class="scope-detail" aria-label="Detalhe do escopo">
      <h3>V{selected.number} · {selected.title}</h3>
      <p>
        Estado comercial: <strong>{labels[selected.state]}</strong> · revisão {selected.version}
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
            .policy_version}, revisão {selected.decision.scope_version}, em {selected
            .decision.decided_at}. {selected.decision.reason}
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
      {#if selected.state === 'submitted'}<p class="muted">
          Somente gestor/admin com alçada explícita e sem participação na
          preparação pode decidir.
        </p>
        {#if canDecide}<label
            >Justificativa da decisão<textarea
              bind:value={decisionReason}
              maxlength="2000"
              required
            ></textarea></label
          ><button
            disabled={busy ||
              !decisionReason.trim() ||
              selected.created_by === userId ||
              selected.submitted_by === userId}
            onclick={() => void run(() => decide('approved'))}
            >Aprovar escopo</button
          ><button
            class="secondary"
            disabled={busy ||
              !decisionReason.trim() ||
              selected.created_by === userId ||
              selected.submitted_by === userId}
            onclick={() => void run(() => decide('rejected'))}
            >Rejeitar escopo</button
          >{/if}{/if}
      {#if selected.state === 'rejected' && view.changes.some((c) => c.proposed_scope_id === selected?.id)}<p
        >
          Change request rejeitado. Selecione a versão atualmente aprovada para
          preparar outro change request.
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
  {#if canPrepare}<form
      aria-label="Revisar cobertura comercial"
      onsubmit={(e) => {
        e.preventDefault();
        void run(link);
      }}
    >
      <h3>Cobertura de demanda</h3>
      <label
        >Demanda para cobertura<select
          bind:value={coverageRequest}
          onchange={() => (coverageItem = '')}
          required
          ><option value="">Selecione</option>{#each data.requests as r}<option
              value={r.id}>{r.title}</option
            >{/each}</select
        ></label
      ><label
        >Item de escopo aprovado<select bind:value={coverageItem}
          ><option value="">Sem cobertura / remover vínculo</option
          >{#each view.scopes.filter((s) => s.state === 'approved' && s.project_id === data.interactions.find((i) => i.id === currentRequest()?.interaction_id)?.project_id) as s}{#each s.items as item}<option
                value={item.id}>V{s.number} · {item.description}</option
              >{/each}{/each}</select
        ></label
      ><button disabled={busy || !coverageRequest}>Confirmar cobertura</button>
    </form>{/if}
  <details>
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
          · {e.created_at}</summary
        >
        <pre>{JSON.stringify(
            { antes: e.before_data, depois: e.after_data },
            null,
            2,
          )}</pre>
      </details>{/each}
  </details>
</section>
