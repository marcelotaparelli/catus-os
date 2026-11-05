<script lang="ts">
  import {
    managerialLabels,
    managerialStates,
    situationLabels,
    syncErrorLabels,
  } from '../shared/clickup';
  import type { ProjectExecution } from '../shared/clickup';
  let {
    execution: e,
    projectId,
    api,
    refresh,
  }: {
    execution: ProjectExecution;
    projectId: string;
    api: (path: string, method: string, body: unknown) => Promise<unknown>;
    refresh: () => Promise<void>;
  } = $props();
  let listId = $state('');
  let failure = $state('');
  const when = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleString('pt-BR', {
          dateStyle: 'short',
          timeStyle: 'short',
        })
      : 'Não disponível';
  const reasonLabels = {
    overdue: 'Atrasada',
    blocked: 'Bloqueada',
    waiting_client: 'Aguardando cliente',
  };
  const lastError = $derived(
    e.links.map((l) => l.last_error_code).find(Boolean),
  );
  const errorText = $derived(
    lastError ? (syncErrorLabels[lastError] ?? 'erro interno') : '',
  );
  async function post(path: string, body: unknown) {
    failure = '';
    try {
      await api('clickup/' + path, 'POST', body);
      await refresh();
    } catch (x) {
      failure = x instanceof Error ? x.message : 'Falha inesperada';
    }
  }
</script>

<section aria-label="Execução no ClickUp">
  <h5>Execução no ClickUp: {situationLabels[e.situation]}</h5>
  {#if e.freshness === 'never_synced'}<p class="attention">
      <strong>Sem dados:</strong> nenhuma leitura concluída{errorText
        ? ` (${errorText})`
        : ''}. Os números ficam indisponíveis até a primeira leitura completa.
    </p>
  {:else if e.freshness === 'failing'}<p class="attention">
      <strong>Dados desatualizados:</strong> a última leitura falhou ({errorText}).
      Os números abaixo são de {when(e.last_sync_at)}.
    </p>
  {:else if e.freshness === 'stale'}<p class="attention">
      <strong>Dados desatualizados:</strong> os números abaixo são de {when(
        e.last_sync_at,
      )}.
    </p>
  {:else if e.freshness === 'fresh'}<p class="muted">
      Última sincronização: {when(e.last_sync_at)}.
    </p>{/if}
  {#if e.counts}
    {@const c = e.counts}
    <dl>
      {#each [['Tarefas abertas', c.tasks_open], ['Tarefas concluídas', c.tasks_closed], ['Subtarefas abertas', c.subtasks_open], ['Subtarefas concluídas', c.subtasks_closed], ['Atrasadas, com subtarefas', c.overdue], ['Abertas sem prazo', c.without_due_date], ['Próximo prazo', when(c.next_due_at)], ['Bloqueadas', c.blocked], ['Aguardando cliente', c.waiting_client], ['Com dependência aberta', c.waiting_dependency], ['Abertas sem responsável', c.unassigned_open]] as [k, v]}
        <div class="kv">
          <dt>{k}</dt>
          <dd>{v ?? 'Não disponível'}</dd>
        </div>
      {/each}
    </dl>
    {#if e.owners.length}
      <details>
        <summary>Responsáveis ({e.owners.length})</summary>
        <ul class="plain">
          {#each e.owners as o}<li>
              {o.name}: {o.open} aberta(s), {o.overdue} atrasada(s)
            </li>{/each}
        </ul>
      </details>
    {/if}
    {#if e.attention.length}
      <details>
        <summary>Atrasos e bloqueios ({e.attention.length})</summary>
        <ul class="plain">
          {#each e.attention as a (a.id)}<li>
              {#if a.url}<a class="text-link" href={a.url} rel="noreferrer"
                  >{a.name}</a
                >{:else}{a.name}{/if}: {a.reasons
                .map((r) => reasonLabels[r])
                .join(', ')}; status “{a.status}”; prazo {when(a.due_at)};
              {a.owners.join(', ') || 'sem responsável'}
            </li>{/each}
        </ul>
      </details>
    {/if}
    {#if e.data_warnings}<p class="attention">
        <strong>Dados incompletos:</strong>
        {e.data_warnings} campo(s) não puderam ser lidos na última sincronização.
      </p>{/if}
    {#if e.removed_from_lists}<p class="muted">
        {e.removed_from_lists} tarefa(s) saíram das listas vinculadas e não entram
        nos números.
      </p>{/if}
    {#if e.unmapped_statuses.length}
      <details>
        <summary
          >Status sem significado definido ({e.unmapped_statuses
            .length})</summary
        >
        <p class="muted">
          Bloqueios só são contados por status mapeado aqui, sem adivinhar pelo
          nome.
        </p>
        {#each e.unmapped_statuses as s (s.status)}
          <form
            onsubmit={(ev) => {
              ev.preventDefault();
              void post('status-mappings', {
                status: s.status,
                state: new FormData(ev.currentTarget).get('state'),
              });
            }}
          >
            <label>
              “{s.status}” ({s.tasks} tarefa(s))
              <select name="state" required>
                <option value="">Escolha</option>
                {#each managerialStates as m}<option value={m}
                    >{managerialLabels[m]}</option
                  >{/each}
              </select>
            </label>
            <button class="secondary">Salvar</button>
          </form>
        {/each}
      </details>
    {/if}
  {/if}
  <details>
    <summary>Listas vinculadas ({e.links.length})</summary>
    <ul class="plain">
      {#each e.links as l (l.id)}<li>
          {l.list_name ?? 'Nome ainda não lido'} (lista {l.list_id}):
          {when(l.last_success_at)}
          <button
            class="secondary"
            onclick={() => post(`links/${l.id}/deactivate`, {})}
            >Desvincular</button
          >
        </li>{/each}
    </ul>
    <form
      onsubmit={async (ev) => {
        ev.preventDefault();
        await post('links', { project_id: projectId, list_id: listId });
        if (!failure) listId = '';
      }}
    >
      <label>
        ID da lista do ClickUp
        <input bind:value={listId} inputmode="numeric" required />
      </label>
      <button class="secondary">Vincular</button>
    </form>
  </details>
  {#if failure}<p role="alert" class="field-error">{failure}</p>{/if}
</section>
