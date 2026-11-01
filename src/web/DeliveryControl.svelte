<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { Snapshot } from '../shared/domain';
  import type { DeliveryView, DeliverySettings } from '../shared/delivery';
  import type { EconomicsView } from '../shared/economics';
  let {
    api,
    data,
    role,
  }: {
    api: <T>(
      path: string,
      method?: string,
      body?: unknown,
      key?: string,
    ) => Promise<T>;
    data: Snapshot;
    role: string;
  } = $props();
  type View = DeliveryView & {
    repositories: {
      key: string;
      repository: string;
      base_branch: string;
      base_sha: string;
      allowed_paths: string[];
    }[];
  };
  let view = $state<View>({
    capability: { available: false, reason: 'Consultando execução' },
    policies: [],
    specs: [],
    jobs: [],
    eligibility: [],
    events: [],
    repositories: [],
  });
  let reports = $state<EconomicsView['reports']>([]),
    busy = $state(false),
    error = $state(''),
    notice = $state('');
  let manager = $derived(['manager', 'administrator'].includes(role));
  let project = $state(''),
    repoKey = $state(''),
    paths = $state<string[]>([]),
    enabled = $state(false),
    reason = $state('');
  let timeout = $state(30),
    inputTokens = $state(16000),
    outputTokens = $state(1024),
    inputPrice = $state(''),
    outputPrice = $state(''),
    jobBudget = $state(''),
    dailyBudget = $state(''),
    totalBudget = $state(''),
    dailyJobs = $state(10),
    concurrency = $state(1),
    margin = $state(1000),
    freshness = $state(60);
  let requestId = $state(''),
    spec = $state(''),
    acceptance = $state(''),
    reportId = $state(''),
    reviewReason = $state('');
  let selectedRepo = $derived(view.repositories.find((r) => r.key === repoKey));
  let currentPolicy = $derived(
    view.policies.find((p) => p.project_id === project),
  );
  const keys = new Map<string, { body: string; key: string }>();
  let destroyed = false,
    timer: ReturnType<typeof setInterval> | undefined;
  async function post<T>(path: string, body: unknown) {
    const json = JSON.stringify(body);
    let a = keys.get(path);
    if (!a || a.body !== json) {
      a = { body: json, key: crypto.randomUUID() };
      keys.set(path, a);
    }
    const r = await api<T>(path, 'POST', body, a.key);
    keys.delete(path);
    return r;
  }
  async function refresh() {
    view = await api<View>('delivery');
    if (manager) reports = (await api<EconomicsView>('economics')).reports;
  }
  async function run(fn: () => Promise<void>) {
    if (busy) return;
    busy = true;
    error = '';
    notice = '';
    try {
      await fn();
      await refresh();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Falha na operação';
    } finally {
      busy = false;
    }
  }
  onMount(() => {
    void run(async () => {});
    timer = setInterval(() => {
      if (
        !destroyed &&
        !busy &&
        view.jobs.some((j) =>
          ['queued', 'claimed', 'running'].includes(j.state),
        )
      )
        void run(async () => {});
    }, 1500);
  });
  onDestroy(() => {
    destroyed = true;
    if (timer) clearInterval(timer);
  });
  function loadPolicy() {
    const p = view.policies.find((p) => p.project_id === project);
    if (!p) {
      enabled = false;
      return;
    }
    enabled = p.enabled;
    repoKey = p.settings.repo_key;
    paths = [...p.settings.allowed_paths];
    timeout = p.settings.timeout_seconds;
    inputTokens = p.settings.max_input_tokens;
    outputTokens = p.settings.max_output_tokens;
    inputPrice = p.settings.input_micro_usd_per_million;
    outputPrice = p.settings.output_micro_usd_per_million;
    jobBudget = p.settings.job_budget_micro_usd;
    dailyBudget = p.settings.daily_budget_micro_usd;
    totalBudget = p.settings.total_budget_micro_usd;
    dailyJobs = p.settings.daily_job_limit;
    concurrency = p.settings.concurrency;
    margin = p.settings.min_margin_bps;
    freshness = p.settings.report_max_age_minutes;
  }
  async function policy() {
    if (!selectedRepo) return;
    const settings: DeliverySettings = {
      repo_key: selectedRepo.key,
      repository: selectedRepo.repository,
      base_branch: selectedRepo.base_branch,
      base_sha: selectedRepo.base_sha,
      allowed_paths: paths,
      task_types: ['nuvemshop-theme'],
      harness: 'responses-api',
      timeout_seconds: timeout,
      max_input_tokens: inputTokens,
      max_output_tokens: outputTokens,
      input_micro_usd_per_million: inputPrice,
      output_micro_usd_per_million: outputPrice,
      job_budget_micro_usd: jobBudget,
      daily_budget_micro_usd: dailyBudget,
      total_budget_micro_usd: totalBudget,
      daily_job_limit: dailyJobs,
      concurrency,
      attempt_limit: 1,
      min_margin_bps: margin,
      report_max_age_minutes: freshness,
      max_diff_bytes: 8192,
    };
    await post('delivery/policies', {
      project_id: project,
      version: currentPolicy?.version ?? 0,
      enabled,
      settings,
      reason,
    });
    notice =
      'Política registrada. Somente demandas com todas as bases válidas entram automaticamente na fila.';
  }
  const labels: Record<string, string> = {
    queued: 'Na fila',
    claimed: 'Obtido pelo runner',
    running: 'Executando',
    awaiting_review: 'Aguardando revisão',
    blocked: 'Bloqueado',
    failed: 'Falhou',
    cancelled: 'Cancelado',
    completed: 'Revisão aceita',
  };
</script>

<section class="panel delivery" aria-label="Entrega agêntica">
  <div class="section-heading">
    <div>
      <p class="eyebrow">M5 · NUVEMSHOP PRIMEIRO</p>
      <h2>Entrega agêntica</h2>
    </div>
    <button class="secondary" disabled={busy} onclick={() => void run(refresh)}
      >Atualizar entrega</button
    >
  </div>
  <p class="muted">
    Runner próprio sob administração da Catus; não é Codex Cloud. Somente
    repositório sintético autorizado, sem merge, deploy ou produção. A revisão
    do diff é humana e separada do estado da demanda.
  </p>
  <p>{view.capability.reason}</p>
  {#if error}<p class="error" role="alert">{error}</p>{/if}{#if notice}<p
      role="status"
    >
      {notice}
    </p>{/if}
  {#if manager}<details>
      <summary>Autorizar política restrita de execução</summary>
      <form
        class="commercial-form"
        aria-label="Política de execução"
        onsubmit={(e) => {
          e.preventDefault();
          void run(policy);
        }}
      >
        <label
          >Projeto da política<select
            bind:value={project}
            onchange={loadPolicy}
            required
            ><option value="">Selecione</option
            >{#each data.projects as p}<option value={p.id}>{p.name}</option
              >{/each}</select
          ></label
        >
        <label
          >Repositório permitido<select
            bind:value={repoKey}
            onchange={() => (paths = [])}
            required
            ><option value="">Selecione da allowlist operacional</option
            >{#each view.repositories as r}<option value={r.key}
                >{r.repository} · {r.base_branch}</option
              >{/each}</select
          ></label
        >
        {#if selectedRepo}<p class="muted">
            Base fixada: {selectedRepo.base_sha}
          </p>
          <fieldset>
            <legend>Caminhos autorizados para alteração</legend
            >{#each selectedRepo.allowed_paths as p}<label
                ><input
                  type="checkbox"
                  bind:group={paths}
                  value={p}
                />{p}</label
              >{/each}
          </fieldset>{/if}
        <label
          >Tempo total máximo em segundos<input
            type="number"
            bind:value={timeout}
            min="5"
            max="120"
            required
          /></label
        ><label
          >Teto de tokens de entrada<input
            type="number"
            bind:value={inputTokens}
            min="1000"
            max="32000"
            required
          /></label
        ><label
          >Teto de tokens de saída<input
            type="number"
            bind:value={outputTokens}
            min="128"
            max="4096"
            required
          /></label
        >
        <label
          >Preço de entrada em microUSD por milhão de tokens<input
            bind:value={inputPrice}
            required
            pattern="[1-9][0-9]*"
          /></label
        ><label
          >Preço de saída em microUSD por milhão de tokens<input
            bind:value={outputPrice}
            required
            pattern="[1-9][0-9]*"
          /></label
        ><label
          >Teto por job em microUSD<input
            bind:value={jobBudget}
            required
            pattern="[1-9][0-9]*"
          /></label
        ><label
          >Teto diário em microUSD<input
            bind:value={dailyBudget}
            required
            pattern="[1-9][0-9]*"
          /></label
        ><label
          >Teto total em microUSD<input
            bind:value={totalBudget}
            required
            pattern="[1-9][0-9]*"
          /></label
        >
        <label
          >Limite diário de jobs<input
            type="number"
            bind:value={dailyJobs}
            min="1"
            max="20"
            required
          /></label
        ><label
          >Concorrência máxima<input
            type="number"
            bind:value={concurrency}
            min="1"
            max="2"
            required
          /></label
        ><label
          >Margem mínima M4 em pontos-base<input
            type="number"
            bind:value={margin}
            min="0"
            max="10000"
            required
          /></label
        ><label
          >Idade máxima da observação em minutos<input
            type="number"
            bind:value={freshness}
            min="1"
            max="240"
            required
          /></label
        >
        <label
          >Justificativa e autorização de execução<textarea
            bind:value={reason}
            maxlength="2000"
            required
          ></textarea></label
        ><label
          ><input type="checkbox" bind:checked={enabled} /> Ativar delegação automática
          somente dentro destes limites</label
        >
        <p class="muted">
          Uma tentativa por versão de especificação. Reserva/consumo do agente
          em USD é separado da economia M4, sem câmbio implícito. Consumo
          conservador da reserva não é fatura.
        </p>
        <button disabled={busy || !paths.length}
          >Salvar política de execução</button
        >
      </form>
    </details>
    <form
      aria-label="Aprovar observação para execução"
      class="commercial-form"
      onsubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await post('delivery/reports/' + reportId + '/approve', {
            reason: reviewReason,
          });
          notice =
            'Observação econômica aprovada independentemente para elegibilidade de execução.';
        });
      }}
    >
      <h3>Autorizar uso da observação econômica</h3>
      <label
        >Observação M4 para execução<select bind:value={reportId} required
          ><option value="">Selecione a mais recente e completa</option
          >{#each reports as r}<option value={r.id}
              >{data.projects.find((p) => p.id === r.project_id)?.name} · {r.created_at}
              · {r.id}</option
            >{/each}</select
        ></label
      ><label
        >Justificativa de revisão M4<input
          bind:value={reviewReason}
          required
          maxlength="2000"
        /></label
      ><button disabled={busy}>Aprovar observação para execução</button>
    </form>{/if}
  {#if role !== 'developer'}<details>
      <summary>Preparar tarefa Nuvemshop</summary>
      <form
        aria-label="Especificação para agente"
        class="commercial-form"
        onsubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const current = view.specs
              .filter((s) => s.request_id === requestId)
              .sort((a, b) => b.revision - a.revision)[0];
            await post('delivery/specs', {
              request_id: requestId,
              revision: current?.revision ?? 0,
              task_type: 'nuvemshop-theme',
              specification: spec,
              acceptance,
              data_scope: 'synthetic',
            });
            notice =
              'Especificação registrada; enfileiramento automático depende de todas as autorizações.';
          });
        }}
      >
        <label
          >Demanda Nuvemshop<select bind:value={requestId} required
            ><option value="">Selecione</option
            >{#each data.requests as r}<option value={r.id}>{r.title}</option
              >{/each}</select
          ></label
        ><label
          >Especificação sintética para engenharia<textarea
            bind:value={spec}
            minlength="30"
            maxlength="6000"
            required
          ></textarea></label
        ><label
          >Critérios de aceite para o runner<textarea
            bind:value={acceptance}
            minlength="15"
            maxlength="3000"
            required
          ></textarea></label
        ><button disabled={busy}>Registrar especificação de engenharia</button>
      </form>
    </details>{/if}
  <h3>Elegibilidade</h3>
  {#each view.eligibility as e}<p>
      {data.requests.find((r) => r.id === e.request_id)?.title ?? e.request_id}:
      <strong>{e.eligible ? 'Elegível pelas bases atuais' : 'Bloqueada'}</strong
      >{e.reasons.length ? ' · ' + e.reasons.join('; ') : ''}
    </p>{:else}<p>
      Nenhuma especificação preparada. Estado ready isolado não autoriza agente.
    </p>{/each}
  <h3>Fila, resultados e revisão humana</h3>
  {#each view.jobs as job}<article
      class="request"
      aria-label={'Job de entrega ' + job.id}
    >
      <h3>
        {data.requests.find((r) => r.id === job.request_id)?.title ??
          job.request_id}
      </h3>
      <p>Estado do job: <strong>{labels[job.state]}</strong> · {job.id}</p>
      {#if job.failure_code}<p>
          Bloqueio/falha: {job.failure_code}. Não reexecutar chamada ambígua
          automaticamente.
        </p>{/if}{#if manager}<p class="muted">
          Reserva: {job.reserved_micro_usd} microUSD · consumo de controle: {job.consumed_micro_usd ??
            'Pendente'}. Não soma valores em BRL ou outras moedas.
        </p>{/if}
      {#if job.result}<p>
          {job.result.llm_verified
            ? 'Responses API: execução verificada neste resultado; Codex SDK não verificado'
            : 'TEST FIXTURE · Codex real NOT_VERIFIED; alterações determinísticas de teste'}
        </p>
        <p>
          Base SHA {job.result.base_sha} · limpeza {job.result.cleanup_confirmed
            ? 'confirmada'
            : 'não confirmada'}
        </p>
        <p>Arquivos: {job.result.files.join(', ')}</p>
        <details>
          <summary>Diff para revisão</summary>
          <pre>{job.result.patch}</pre>
        </details>
        <details>
          <summary>Testes reais e códigos de saída</summary
          >{#each job.result.tests as t}<p>
              {t.argv.join(' ')} · saída {t.exit_code}
            </p>
            <pre>{t.log}</pre>{/each}
        </details>
        <p class="muted">
          Patch preservado no sistema. Nenhum PR remoto, merge ou deploy foi
          criado por este resultado.
        </p>{/if}
      {#if manager && job.state === 'awaiting_review'}<label
          >Decisão humana sobre o diff<input
            bind:value={reviewReason}
            maxlength="2000"
            placeholder="O que foi conferido nesta revisão"
          /></label
        >{#each [['accepted', 'Aceitar revisão'], ['rejected', 'Rejeitar entrega'], ['correction_requested', 'Solicitar correção']] as [decision, label]}<button
            class="secondary"
            disabled={busy || !reviewReason.trim()}
            onclick={() =>
              void run(async () => {
                await post('delivery/jobs/' + job.id + '/review', {
                  decision,
                  reason: reviewReason,
                });
                notice = 'Revisão registrada, sem integrar código na base.';
              })}>{label}</button
          >{/each}{/if}
      {#if manager && ['queued', 'claimed', 'running', 'awaiting_review'].includes(job.state)}<label
          >Motivo do cancelamento<input
            bind:value={reviewReason}
            maxlength="2000"
          /></label
        ><button
          class="secondary"
          disabled={busy || !reviewReason.trim()}
          onclick={() =>
            void run(async () => {
              await post('delivery/jobs/' + job.id + '/cancel', {
                reason: reviewReason,
              });
            })}>Cancelar job</button
        >{/if}
    </article>{:else}<p>
      Nenhum job enfileirado. Execução permanece negada até satisfazer todos os
      requisitos.
    </p>{/each}
  <details>
    <summary>Eventos de execução</summary>{#each view.events as e}<p>
        {e.created_at} · {e.action} · {e.actor} · {e.actor_user_id ??
          'serviço, sem autoria humana simulada'}
      </p>{/each}
  </details>
</section>
