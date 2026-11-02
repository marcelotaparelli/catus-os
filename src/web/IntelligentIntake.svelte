<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { Interaction, Project } from '../shared/domain';
  import type {
    AiCapability,
    ExtractionJob,
    Proposal,
  } from '../shared/extraction';
  import type { Member as OrgMember } from '../shared/identity';
  let {
    api,
    interactions,
    projects,
    members,
    role,
    onCreated,
  }: {
    api: <T>(
      path: string,
      method?: string,
      body?: unknown,
      key?: string,
    ) => Promise<T>;
    interactions: Interaction[];
    projects: Project[];
    members: OrgMember[];
    role: string;
    onCreated: () => Promise<void>;
  } = $props();
  let capability = $state<AiCapability | null>(null);
  let jobs = $state<ExtractionJob[]>([]);
  let selected = $state<ExtractionJob | null>(null);
  let interaction = $state('');
  let scope = $state('synthetic');
  let consent = $state(false);
  let busy = $state(false);
  let error = $state('');
  let info = $state('');
  let checked = $state<string[]>([]);
  let owner = $state('');
  let nextAction = $state('');
  let confirmed = $state(false);
  let duplicatesConfirmed = $state(false);
  let editing = $state<Proposal | null>(null);
  let title = $state('');
  let description = $state('');
  let criteria = $state('');
  let queueKey = crypto.randomUUID();
  let approvalKey = crypto.randomUUID();
  let timer: ReturnType<typeof setInterval> | undefined;
  let destroyed = false;
  let polling = false;
  async function refresh() {
    capability = await api<AiCapability>('extraction');
    jobs = await api<ExtractionJob[]>('extractions');
    if (selected)
      selected = await api<ExtractionJob>('extractions/' + selected.id);
  }
  async function run(action: () => Promise<void>) {
    if (busy) return;
    busy = true;
    error = '';
    info = '';
    try {
      await action();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Falha na operação';
    } finally {
      busy = false;
    }
  }
  onMount(() => {
    void run(refresh);
    timer = setInterval(() => {
      if (
        !destroyed &&
        !polling &&
        !busy &&
        jobs.some((j) => j.state === 'queued' || j.state === 'running')
      ) {
        polling = true;
        void refresh()
          .catch(() => {
            error = 'Não foi possível atualizar extrações';
          })
          .finally(() => (polling = false));
      }
    }, 2000);
  });
  onDestroy(() => {
    destroyed = true;
    if (timer) clearInterval(timer);
  });
  async function open(id: string) {
    await run(async () => {
      selected = await api<ExtractionJob>('extractions/' + id);
      checked = [];
      editing = null;
      confirmed = false;
      duplicatesConfirmed = false;
      approvalKey = crypto.randomUUID();
    });
  }
  async function enqueue() {
    await run(async () => {
      const result = await api<{ id: string }>(
        'extractions',
        'POST',
        {
          interaction_id: interaction,
          data_scope: scope,
          confirm_external_processing: consent,
        },
        queueKey,
      );
      queueKey = crypto.randomUUID();
      await refresh();
      selected = await api<ExtractionJob>('extractions/' + result.id);
      info = 'Extração enfileirada; propostas ainda exigem revisão humana.';
    });
  }
  function edit(p: Proposal) {
    editing = p;
    title = p.title;
    description = p.description;
    criteria = p.acceptance_criteria.map((c) => c.text).join('\n');
  }
  async function save() {
    if (!editing) return;
    const p = editing;
    await run(async () => {
      await api('proposals/' + p.id, 'PATCH', {
        action: 'edited',
        version: p.version,
        title,
        description,
        acceptance_criteria: criteria.split('\n').filter(Boolean),
      });
      editing = null;
      await refresh();
      info = 'Edição humana registrada no histórico.';
    });
  }
  async function reject(p: Proposal) {
    await run(async () => {
      await api('proposals/' + p.id, 'PATCH', {
        action: 'rejected',
        version: p.version,
      });
      checked = checked.filter((id) => id !== p.id);
      await refresh();
      info = 'Proposta rejeitada, sem criar demanda.';
    });
  }
  async function approve() {
    if (!selected) return;
    const job = selected;
    await run(async () => {
      const result = await api<{ created: { request_id: string }[] }>(
        'extractions/' + job.id + '/approve',
        'POST',
        {
          confirm_human_review: confirmed,
          acknowledge_duplicates: duplicatesConfirmed,
          proposals: job.proposals
            .filter((p) => checked.includes(p.id) && p.state === 'proposed')
            .map((p) => ({
              id: p.id,
              version: p.version,
              owner_user_id: owner,
              next_action: nextAction,
            })),
        },
        approvalKey,
      );
      approvalKey = crypto.randomUUID();
      checked = [];
      confirmed = false;
      await refresh();
      await onCreated();
      info = `${result.created.length} demandas criadas por confirmação humana. Escopo e contrato não foram aprovados.`;
    });
  }
  const factSections = $derived(
    selected?.result
      ? [
          { label: 'Requisitos', facts: selected.result.requirements },
          { label: 'Decisões', facts: selected.result.decisions },
          { label: 'Compromissos', facts: selected.result.commitments },
        ]
      : [],
  );
  const kinds: Record<string, string> = {
    meeting: 'Reunião',
    service: 'Atendimento',
    conversation: 'Conversa',
    observation: 'Observação',
  };
  const labels: Record<string, string> = {
    queued: 'Na fila',
    running: 'Processando',
    succeeded: 'Pronta para revisão',
    failed: 'Falhou',
    proposed: 'Proposta não aprovada',
    accepted: 'Demanda criada',
    rejected: 'Rejeitada',
  };
</script>

<section class="panel" aria-label="Atendimento inteligente">
  <div class="section-heading">
    <div>
      <p class="eyebrow">CONTEXTO → PROPOSTAS → REVISÃO HUMANA</p>
      <h2>Atendimento inteligente</h2>
    </div>
    <button class="secondary" disabled={busy} onclick={() => run(refresh)}
      >Atualizar extrações</button
    >
  </div>
  <p class="muted">
    {capability?.reason ?? 'Verificando disponibilidade da IA…'}
  </p>
  <p>
    A IA sugere; o PO decide. Conversas são dados não confiáveis. Não envie
    dados reais sem política e autorização. Propostas e critérios sugeridos
    precisam ser conferidos na origem.
  </p>
  {#if role === 'administrator'}<details>
      <summary>Configurar política da organização</summary>
      <p class="muted">
        Somente dados sintéticos nesta configuração inicial. Referência registra
        a autorização administrativa; não configura credenciais.
      </p>
      <form
        onsubmit={(e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          void run(async () => {
            await api('ai/policy', 'POST', {
              enabled: true,
              policy_reference: String(form.get('policy')),
              data_scope: 'synthetic',
              daily_budget_micro_usd: 1000000,
              per_job_budget_micro_usd: 100000,
              daily_job_limit: 20,
            });
            await refresh();
          });
        }}
      >
        <label
          >Referência da política<input
            name="policy"
            required
            maxlength="500"
          /></label
        ><button disabled={busy}
          >Habilitar política para dados sintéticos</button
        >
      </form>
    </details>{/if}
  <form
    onsubmit={(e) => {
      e.preventDefault();
      void enqueue();
    }}
  >
    <div class="intake-row">
      <label
        >Atendimento para extração<select bind:value={interaction} required
          ><option value="">Selecione</option>{#each interactions as i}<option
              value={i.id}
              >{projects.find((p) => p.id === i.project_id)?.name} · {kinds[
                i.kind
              ]} · {i.summary.slice(0, 80)}</option
            >{/each}</select
        ></label
      ><label
        >Classificação dos dados<select bind:value={scope}
          ><option value="synthetic">Sintéticos</option
          >{#if capability?.policy?.data_scope === 'authorized_client'}<option
              value="authorized_client"
              >Cliente com autorização registrada</option
            >{/if}</select
        ></label
      >
    </div>
    <label class="check"
      ><input type="checkbox" bind:checked={consent} required /> Confirmo a classificação
      e o envio externo conforme a política da organização.</label
    ><button disabled={busy || !capability?.available || !interactions.length}
      >Extrair com IA</button
    >
  </form>
  {#if !capability?.available}<p class="muted">
      Inferência indisponível. Nenhum resultado de demonstração é gerado pelo
      aplicativo.
    </p>{/if}
  <h3>Histórico de extrações</h3>
  <div class="intake-history">
    {#each jobs as j}<button
        class="secondary"
        disabled={busy}
        onclick={() => open(j.id)}
        >{new Date(j.created_at).toLocaleString()} · {labels[j.state]} · {j
          .provider_config.model}</button
      >{/each}{#if !jobs.length}<p class="muted">
        Nenhuma extração registrada.
      </p>{/if}
  </div>
  {#if selected}<section
      class="extraction-detail"
      aria-label="Revisão da extração"
    >
      <h3>{labels[selected.state]}</h3>
      <p class="muted">
        Extração {selected.id} · origem {selected.interaction_id} · prompt {selected
          .provider_config.promptVersion}
      </p>
      <p class="muted">
        Tokens entrada/saída: {selected.input_tokens ?? 'não informados'} / {selected.output_tokens ??
          'não informados'} · latência: {selected.latency_ms ?? '—'} ms · custo estimado:
        {selected.estimated_cost_micro_usd !== null
          ? `USD ${(Number(selected.estimated_cost_micro_usd) / 1000000).toFixed(6)}`
          : 'não informado'} · consumo conservador do orçamento: {selected.consumed_micro_usd !==
        null
          ? `USD ${(Number(selected.consumed_micro_usd) / 1000000).toFixed(6)}`
          : 'reservado'}
      </p>
      <details>
        <summary>Texto de origem preservado</summary>
        <p class="source-text">{selected.source_text}</p>
        <p class="muted">SHA-256: {selected.source_hash}</p>
      </details>
      {#if selected.failure_code}<p role="alert">
          Processamento recusado: {selected.failure_code}. Não há demandas
          geradas. Uma nova tentativa manual exige nova reserva.
        </p>{/if}
      {#if selected.result}
        <h3>Resumo sugerido</h3>
        <p>{selected.result.summary.text}</p>
        <details>
          <summary>Evidências do resumo</summary
          >{#each selected.result.summary.evidence as e}<blockquote>
              {e.quote} <small>[{e.start}, {e.end})</small>
            </blockquote>{/each}
        </details>
        {#each factSections as { label, facts }}<h3>{label}</h3>
          {#each facts as fact}<p>{fact.text}</p>
            {#each fact.evidence as e}<blockquote>
                {e.quote}
              </blockquote>{/each}{/each}{/each}
        <h3>Informações ausentes</h3>
        <ul>
          {#each selected.result.missing_information as item}<li>
              {item}
            </li>{/each}
        </ul>
        <h3>Perguntas para o cliente</h3>
        <ul>
          {#each selected.result.questions as q}<li>{q}</li>{/each}
        </ul>
      {/if}
      <div class="cards">
        {#each selected.proposals as p}<article
            class="request"
            aria-label={'Proposta ' + p.title}
          >
            <div class="card-top">
              <span class="status">{labels[p.state]}</span><span
                >v{p.version}</span
              >
            </div>
            <h3>{p.title}</h3>
            <p>{p.description}</p>
            <h4>Critérios sugeridos — conferir com a origem</h4>
            <ul>
              {#each p.acceptance_criteria as c}<li>{c.text}</li>{/each}
            </ul>
            <h4>Evidência de origem</h4>
            {#each p.evidence as e}<blockquote>
                {e.quote} <small>[{e.start}, {e.end})</small>
              </blockquote>{/each}
            {#if p.duplicates.length}<p class="duplicate">
                Possíveis duplicidades (sugestão local, não decisão)
              </p>
              <ul>
                {#each p.duplicates as d}<li>
                    {d.type}: {d.title} · {d.id}
                  </li>{/each}
              </ul>{/if}
            {#if p.state === 'proposed'}<label class="check"
                ><input type="checkbox" bind:group={checked} value={p.id} /> Selecionar
                para criar demanda</label
              ><button class="secondary" disabled={busy} onclick={() => edit(p)}
                >Editar proposta</button
              >
              <button
                class="secondary"
                disabled={busy}
                onclick={() => reject(p)}>Rejeitar proposta</button
              >{:else if p.request_id}<p>
                Demanda vinculada: {p.request_id}
              </p>{/if}
          </article>{/each}
      </div>
      {#if editing}<form
          class="panel"
          aria-label="Editar proposta"
          onsubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <h3>Edição humana: {editing.title}</h3>
          <label
            >Título revisado<input
              bind:value={title}
              required
              maxlength="200"
            /></label
          ><label
            >Descrição revisada<textarea
              bind:value={description}
              required
              maxlength="4000"
            ></textarea></label
          ><label
            >Critérios revisados (um por linha)<textarea
              bind:value={criteria}
              required
            ></textarea></label
          >
          <p class="muted">
            A edição será atribuída a você. A extração original e suas
            evidências serão preservadas.
          </p>
          <button disabled={busy}>Salvar revisão</button><button
            type="button"
            class="secondary"
            onclick={() => (editing = null)}>Cancelar revisão</button
          >
        </form>{/if}
      {#if selected.proposals.some((p) => p.state === 'proposed')}<form
          class="panel"
          aria-label="Confirmar demandas"
          onsubmit={(e) => {
            e.preventDefault();
            void approve();
          }}
        >
          <h3>Criar somente as propostas selecionadas</h3>
          <label
            >Responsável pelas demandas<select bind:value={owner} required
              ><option value="">Selecione</option>{#each members as m}<option
                  value={m.id}>{m.name} · {m.email}</option
                >{/each}</select
            ></label
          ><label
            >Próxima ação das demandas<textarea
              bind:value={nextAction}
              required
              maxlength="2000"
            ></textarea></label
          ><label class="check"
            ><input type="checkbox" bind:checked={confirmed} required /> Revisei a
            origem e confirmo a criação das demandas selecionadas. Isto não aprova
            escopo ou contrato.</label
          ><label class="check"
            ><input type="checkbox" bind:checked={duplicatesConfirmed} /> Revisei
            as possíveis duplicidades e desejo prosseguir.</label
          ><button disabled={busy || !checked.length}
            >Criar demandas selecionadas</button
          >
        </form>{/if}
      <h3>Histórico de revisões humanas</h3>
      <ul>
        {#each selected.reviews as r}<li>
            {new Date(r.created_at).toLocaleString()} · {r.action} · autor {r.actor_user_id}
            · proposta {r.proposal_id}
            <details>
              <summary>Antes / depois</summary>
              <!-- svelte-ignore a11y_no_noninteractive_tabindex (scrollable region must be keyboard reachable, WCAG 2.1.1) -->
              <pre tabindex="0">{JSON.stringify(
                  { antes: r.before_snapshot, depois: r.after_snapshot },
                  null,
                  2,
                )}</pre>
            </details>
          </li>{/each}{#if !selected.reviews.length}<li>
            Nenhuma revisão humana ainda.
          </li>{/if}
      </ul>
    </section>{/if}
  {#if error}<p role="alert" class="inline-error">{error}</p>{/if}{#if info}<p
      role="status"
    >
      {info}
    </p>{/if}
</section>
