<script lang="ts">
  import type { Member } from '../shared/identity';
  interface AuditEvent {
    id: string;
    actor_user_id: string | null;
    actor: string;
    entity_type: string;
    entity_id: string;
    action: string;
    created_at: string;
  }
  let {
    api,
    members,
  }: {
    api: <T>(path: string) => Promise<T>;
    members: Member[];
  } = $props();
  let events = $state<AuditEvent[] | null>(null);
  let loading = $state(false);
  let failure = $state('');
  let type = $state('');
  let actor = $state('');
  const typeLabels: Record<string, string> = {
    client: 'Cliente',
    project: 'Projeto',
    interaction: 'Atendimento',
    request: 'Solicitação',
    membership: 'Acesso',
    session: 'Sessão',
  };
  let types = $derived([...new Set((events ?? []).map((e) => e.entity_type))]);
  let actors = $derived([...new Set((events ?? []).map((e) => e.actor))]);
  let shown = $derived(
    (events ?? []).filter(
      (e) => (!type || e.entity_type === type) && (!actor || e.actor === actor),
    ),
  );
  async function load() {
    loading = true;
    failure = '';
    try {
      events = await api<AuditEvent[]>('audit');
    } catch (e) {
      failure =
        e instanceof Error
          ? e.message
          : 'Não foi possível carregar a auditoria';
    } finally {
      loading = false;
    }
  }
  function when(iso: string) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? iso
      : d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'medium' });
  }
</script>

<section class="panel" aria-label="Auditoria">
  <div class="section-heading">
    <div>
      <p class="eyebrow">RASTREABILIDADE</p>
      <h2>Auditoria operacional</h2>
    </div>
    <button class="secondary" disabled={loading} onclick={load}
      >{events ? 'Atualizar auditoria' : 'Carregar auditoria'}</button
    >
  </div>
  <p class="muted">
    Somente leitura. Até 500 eventos mais recentes da organização, com autor
    identificado pela sessão. Contratos, economia e entrega mantêm históricos
    próprios em seus módulos.
  </p>
  {#if loading}<p role="status">Carregando eventos…</p>{/if}
  {#if failure}<p class="inline-error" role="alert">{failure}</p>{/if}
  {#if events}
    <div class="filters">
      <label
        >Tipo de registro<select bind:value={type}
          ><option value="">Todos</option>{#each types as t}<option value={t}
              >{typeLabels[t] ?? t}</option
            >{/each}</select
        ></label
      ><label
        >Autor<select bind:value={actor}
          ><option value="">Todos</option>{#each actors as a}<option value={a}
              >{a}</option
            >{/each}</select
        ></label
      >
    </div>
    {#if !shown.length}<div class="empty">
        <h3>Nenhum evento neste recorte</h3>
      </div>{:else}<div class="table-wrap">
        <table>
          <caption class="muted">{shown.length} evento(s)</caption>
          <thead
            ><tr
              ><th scope="col">Quando</th><th scope="col">Autor</th><th
                scope="col">Registro</th
              ><th scope="col">Ação</th><th scope="col">Identificador</th></tr
            ></thead
          >
          <tbody>
            {#each shown as e (e.id)}<tr
                ><td>{when(e.created_at)}</td><td
                  >{e.actor}{#if e.actor_user_id && !members.some((m) => m.id === e.actor_user_id)}<span
                      class="muted"
                    >
                      · inativo</span
                    >{/if}</td
                ><td>{typeLabels[e.entity_type] ?? e.entity_type}</td><td
                  >{e.action}</td
                ><td><code>{e.entity_id}</code></td></tr
              >{/each}
          </tbody>
        </table>
      </div>{/if}
  {/if}
</section>
