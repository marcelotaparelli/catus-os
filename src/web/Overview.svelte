<script lang="ts">
  import {
    dayLabel,
    hoursLabel,
    moneyGrouped,
    percentLabel,
  } from '../shared/economics';
  import { healthLabels, healthOrder } from '../shared/overview';
  import type {
    ActionTarget,
    Overview,
    ProjectOverview,
    RecommendedAction,
  } from '../shared/overview';
  import { statusLabels } from '../shared/domain';
  import type { Status, WorkRequest } from '../shared/domain';
  import { href } from './routes';
  let {
    overview,
    error,
    requests,
    userId,
  }: {
    overview: Overview | null;
    error: string;
    requests: WorkRequest[];
    userId: string;
  } = $props();
  const signs: Record<string, string> = {
    negative: '▼',
    at_risk: '▲',
    incomplete: '?',
    unmeasured: '–',
    positive: '●',
  };
  const link = (t: ActionTarget) => href(t.route, t.query);
  const signed = (n: number | null | undefined) =>
    n == null ? 'Indisponível' : (n > 0 ? '+' : '') + hoursLabel(n);
  const signedMoney = (m: string | null | undefined, c: string) =>
    m == null
      ? 'Indisponível'
      : (BigInt(m) > 0n ? '+' : '') + moneyGrouped(m, c);
  /** Share of the bar; the widest of realized + remaining and planned is 100%. */
  function bar(p: ProjectOverview) {
    const r = p.result;
    if (!r || r.planned_minutes === null || r.remaining_minutes === null)
      return null;
    const total = Math.max(
      r.approved_minutes + r.remaining_minutes,
      r.planned_minutes,
      1,
    );
    return {
      done: (r.approved_minutes / total) * 100,
      left: (r.remaining_minutes / total) * 100,
      plan: (r.planned_minutes / total) * 100,
    };
  }
  let projects = $derived(
    overview?.kind === 'financial' ? overview.projects : [],
  );
  let attention = $derived(projects.filter((p) => p.health !== 'positive'));
  let top = $derived(
    overview?.kind === 'financial'
      ? [
          ...overview.organization_actions.map((a) => ({
            a,
            p: null as ProjectOverview | null,
          })),
          ...attention
            .filter((p) => p.actions.length)
            .map((p) => ({ a: p.actions[0]!, p })),
        ]
      : [],
  );
  let mine = $derived(
    requests.filter((r) => r.status !== 'done' && r.owner_user_id === userId)
      .length,
  );
</script>

{#snippet action(a: RecommendedAction, label: string | null)}
  <div>
    {#if label}<p class="eyebrow">{label}</p>{/if}
    <strong>{a.action}</strong>
    <p class="muted">Por quê: {a.reason}</p>
    <p>
      <span class="muted">Responsável:</span>
      {a.owner} <span class="muted">({a.owner_basis})</span>
    </p>
  </div>
  <a
    class="button-link secondary"
    href={link(a.target)}
    aria-label={'Abrir: ' + a.action}>Abrir</a
  >
{/snippet}

{#snippet metric(name: string, value: string)}
  <div class="kv">
    <dt>{name}</dt>
    <dd>{value}</dd>
  </div>
{/snippet}

{#snippet project(p: ProjectOverview)}
  {@const r = p.result}
  {@const b = bar(p)}
  <article class="project" aria-label={'Projeto ' + p.project_name}>
    <div class="project-head">
      <div>
        <p class="eyebrow">{p.client_name}</p>
        <h4>{p.project_name}</h4>
        <p class="muted">{p.health_reason}</p>
      </div>
      <span class="health" data-health={p.health}
        ><span aria-hidden="true">{signs[p.health]}</span>
        {healthLabels[p.health]}</span
      >
    </div>
    {#if r}
      <div class="metrics">
        <div>
          <h5>Margem projetada</h5>
          <p class="figure">
            {moneyGrouped(r.projected_margin, r.currency)}
            <small
              >{r.projected_margin_bps == null
                ? ''
                : percentLabel(r.projected_margin_bps) + ' da receita'}</small
            >
          </p>
          <dl>
            {@render metric(
              'Realizada',
              moneyGrouped(r.realized_margin, r.currency),
            )}
            {@render metric('% realizada', percentLabel(r.realized_margin_bps))}
          </dl>
        </div>
        <div>
          <h5>Receita contratada</h5>
          <p class="figure">
            {moneyGrouped(r.contracted_revenue, r.currency)}
          </p>
          <dl>
            {@render metric(
              'Reconhecida',
              moneyGrouped(r.recognized_revenue, r.currency),
            )}
            {@render metric(
              'Projetada',
              moneyGrouped(r.projected_revenue, r.currency),
            )}
          </dl>
        </div>
        <div>
          <h5>Custo na conclusão (EAC)</h5>
          <p class="figure">
            {moneyGrouped(r.eac, r.currency)}
            <small
              >{r.cost_variance == null
                ? ''
                : signedMoney(r.cost_variance, r.currency) +
                  ' sobre o orçamento'}</small
            >
          </p>
          <dl>
            {@render metric(
              'Orçamento',
              moneyGrouped(r.budget_cost, r.currency),
            )}
            {@render metric(
              'Incorrido, sem deduções',
              moneyGrouped(r.cost_incurred, r.currency),
            )}
          </dl>
        </div>
        <div>
          <h5>Horas: desvio previsto</h5>
          <p class="figure">
            {signed(r.hours_variance_minutes)}
            <small
              >{r.planned_minutes == null
                ? ''
                : hoursLabel(r.planned_minutes) + ' previstas'}</small
            >
          </p>
          {#if b}<div
              class="hours-bar"
              aria-hidden="true"
              title="Realizado + restante; o traço marca o previsto"
            >
              <span class="done" style:width="{b.done}%"></span><span
                class="left"
                style:width="{b.left}%"
              ></span><i style:left="{b.plan}%"></i>
            </div>
            <p class="bar-key" aria-hidden="true">
              <span class="done">Realizado</span><span class="left">Falta</span
              ><span class="plan">Previsto</span>
            </p>{/if}
          <dl>
            {@render metric(
              'Realizado (aprovado)',
              hoursLabel(r.approved_minutes),
            )}
            {#if r.pending_minutes}{@render metric(
                'Pendente de decisão',
                hoursLabel(r.pending_minutes),
              )}{/if}
            {@render metric('Falta', hoursLabel(r.remaining_minutes))}
          </dl>
        </div>
      </div>
    {/if}
    {#if r?.pending_minutes}<p class="attention">
        <strong>Atenção:</strong>
        {hoursLabel(r.pending_minutes)} pendentes de decisão ainda não entram em custo,
        desvio ou previsão acima; os números vão mudar quando forem decididas.
      </p>{/if}
    {#if p.projection_missing.length}<p class="attention">
        <strong>Faltam para a margem:</strong>
        {p.projection_missing
          .map((m) => (m.count > 1 ? `${m.label} (${m.count})` : m.label))
          .join('; ')}.
      </p>{/if}
    {#if p.actions.length}
      <details>
        <summary>Próximas ações ({p.actions.length})</summary>
        <ol class="action-list">
          {#each p.actions as a}<li>{@render action(a, null)}</li>{/each}
        </ol>
      </details>
    {:else}<p class="muted">Nenhuma ação pendente neste projeto.</p>{/if}
    {#if p.hours.length}
      <details>
        <summary>Onde as horas estão sendo consumidas</summary>
        <!-- svelte-ignore a11y_no_noninteractive_tabindex (scrollable region must be keyboard reachable, WCAG 2.1.1) -->
        <div class="table-scroll" tabindex="0">
          <table>
            <thead
              ><tr
                ><th scope="col">Demanda</th><th scope="col">Responsável</th><th
                  scope="col">Previsto</th
                ><th scope="col">Realizado</th><th scope="col">Falta</th><th
                  scope="col">Desvio</th
                ><th scope="col">Prazo</th></tr
              ></thead
            >
            <tbody>
              {#each p.hours as h (h.request_id)}<tr>
                  <th scope="row">{h.title}</th>
                  <td>{h.owner}</td>
                  <td>{hoursLabel(h.planned_minutes)}</td>
                  <td
                    >{hoursLabel(h.approved_minutes)}{#if h.pending_minutes}
                      <span class="muted"
                        >+ {hoursLabel(h.pending_minutes)} pend.</span
                      >{/if}</td
                  >
                  <td>{hoursLabel(h.remaining_minutes)}</td>
                  <td>{signed(h.variance_minutes)}</td>
                  <td
                    >{h.expected_on
                      ? dayLabel(h.expected_on)
                      : 'Sem prazo'}{#if h.overdue}{' '}<strong>vencido</strong
                      >{/if}</td
                  >
                </tr>{/each}
            </tbody>
          </table>
        </div>
      </details>
    {/if}
    {#if p.source}
      <details>
        <summary>De onde vêm estes números</summary>
        <ul class="sources">
          <li>
            Cálculo ao vivo pelo motor {r?.engine_version} com corte em {dayLabel(
              r?.as_of,
            )}; competência {dayLabel(r?.period_from)} a {dayLabel(
              r?.period_until,
            )}, em {r?.currency}.
          </li>
          <li>
            Contrato “{p.source.contract_title}” ({p.source.regime ===
            'retainer'
              ? 'retainer'
              : 'preço fechado'}), escopo V{p.source.scope_number}, termos
            revisão {p.source.terms_revision} ({p.source.terms_id}), fonte: {p
              .source.terms_source}.
          </li>
          <li>
            {p.source.approved_time_entries} apontamento(s) e {p.source
              .approved_estimates} estimativa(s) aprovados; pendentes não entram no
            custo.
          </li>
          <li>
            {#if p.source.latest_report}Última observação preservada: {p.source
                .latest_report.id}, corte {dayLabel(
                p.source.latest_report.as_of,
              )}, hash {p.source.latest_report.input_hash.slice(0, 12)}…
              {p.source.latest_report.matches_live
                ? 'Coincide com o cálculo atual.'
                : 'Difere do cálculo atual: os dados mudaram depois dela.'}
            {:else}Nenhuma observação preservada; gere uma em Economia para
              congelar estes valores.{/if}
          </li>
          {#if p.actual_missing.length}<li>
              Realizado depende de: {p.actual_missing
                .map((m) => m.label)
                .join('; ')}.
            </li>{/if}
        </ul>
        <a class="text-link" href={href('economia', { projeto: p.project_id })}
          >Abrir fórmulas e histórico em Economia</a
        >
      </details>
    {/if}
  </article>
{/snippet}

{#snippet portfolio()}
  <p class="muted">
    Corte {dayLabel(overview?.as_of)}, a partir de registros aprovados. Dado
    ausente fica indisponível, nunca zero. Moedas e competências diferentes não
    são somadas.
  </p>
  <ul class="health-legend" aria-label="Projetos por situação">
    {#each healthOrder as h}
      {@const n = projects.filter((p) => p.health === h).length}
      {#if n}<li>
          <span class="health" data-health={h}
            ><span aria-hidden="true">{signs[h]}</span>
            {healthLabels[h]}</span
          >
          <strong>{n}</strong>
        </li>{/if}
    {/each}
  </ul>
  {#if top.length}
    <h3 id="exec-now">O que fazer agora</h3>
    <ol class="action-list" aria-labelledby="exec-now">
      {#each top as t}<li>
          {@render action(
            t.a,
            t.p
              ? `${t.p.project_name} · ${healthLabels[t.p.health]}`
              : 'Organização',
          )}
        </li>{/each}
    </ol>
  {/if}
  {#if projects.length}
    <h3>Projetos</h3>
    {#each projects as p (p.project_id)}{@render project(p)}{/each}
  {/if}
{/snippet}

{#if error}
  <section class="panel" aria-label="Leitura indisponível">
    <p role="alert" class="muted">
      Não foi possível carregar a leitura deste papel: {error}. Nenhum valor é
      exibido no lugar dela; use <strong>Atualizar dados</strong>.
    </p>
  </section>
{:else if overview?.kind === 'financial'}
  {#if overview.governance}
    <section class="panel" aria-label="Governança">
      <p class="eyebrow">ADMINISTRAÇÃO</p>
      <h2>Governança</h2>
      <p class="muted">
        {overview.governance.members_by_role.administrator} administrador(es) ·
        {overview.governance.members_by_role.manager} gestor(es) ·
        {overview.governance.members_by_role.po} PO(s) ·
        {overview.governance.members_by_role.developer} desenvolvedor(es).
      </p>
      <p class="gov-links">
        <a class="text-link" href={href('acesso')}>Gerenciar acesso</a>
        <a class="text-link" href={href('auditoria')}>Ver auditoria</a>
      </p>
      <ul class="gov-checks">
        {#each overview.governance.checks as c (c.id)}<li>
            <span class="health" data-health={c.ok ? 'positive' : 'at_risk'}
              ><span aria-hidden="true">{c.ok ? '●' : '▲'}</span>
              {c.ok ? 'Em dia' : 'Atenção'}</span
            >
            <div>
              <strong>{c.label}</strong>
              <p class="muted">{c.detail}</p>
            </div>
            {#if !c.ok}<a class="text-link" href={link(c.target)}>Resolver</a
              >{/if}
          </li>{/each}
      </ul>
      <details class="exec-collapsed">
        <summary>Visão executiva (rentabilidade por projeto)</summary>
        {@render portfolio()}
      </details>
    </section>
  {:else}
    <section class="panel exec" aria-label="Visão executiva">
      <p class="eyebrow">VISÃO EXECUTIVA</p>
      <h2>
        {#if !projects.length}Nenhum projeto cadastrado{:else if attention.length}{attention.length}
          de {projects.length}
          {projects.length === 1 ? 'projeto precisa' : 'projetos precisam'} de atenção{:else}Todos
          os {projects.length} projetos sem desvio{/if}
      </h2>
      {@render portfolio()}
    </section>
  {/if}
{:else if overview?.kind === 'operational'}
  <section class="panel exec" aria-label="Operação do PO">
    <p class="eyebrow">OPERAÇÃO DO PO</p>
    <h2>
      {overview.actions.length
        ? `${overview.actions.length} ${overview.actions.length === 1 ? 'ação recomendada' : 'ações recomendadas'}`
        : 'Sem pendências de demanda e escopo'}
    </h2>
    {#if overview.pending_changes}<p class="attention">
        {overview.pending_changes} change request(s) aguardando decisão.
        <a href={href('comercial')}>Ver no Comercial</a>
      </p>{/if}
    {#if overview.actions.length}
      <ol class="action-list" aria-label="Próximas ações do PO">
        {#each overview.actions.slice(0, 6) as a}<li>
            {@render action(a, null)}
          </li>{/each}
      </ol>
      {#if overview.actions.length > 6}<p class="muted">
          E mais {overview.actions.length - 6}.
        </p>{/if}
    {/if}
    {#if overview.demands.length}
      <h3 id="po-demands">Demandas e prazos</h3>
      <!-- svelte-ignore a11y_no_noninteractive_tabindex (scrollable region must be keyboard reachable, WCAG 2.1.1) -->
      <div class="table-scroll" tabindex="0" aria-labelledby="po-demands">
        <table>
          <thead
            ><tr
              ><th scope="col">Demanda</th><th scope="col">Estado</th><th
                scope="col">Responsável</th
              ><th scope="col">Prazo</th><th scope="col">Falta</th><th
                scope="col">Cobertura</th
              ></tr
            ></thead
          >
          <tbody>
            {#each overview.demands as d (d.id)}<tr>
                <th scope="row"
                  >{d.title}<br /><span class="muted">{d.project_name}</span
                  ></th
                >
                <td
                  ><span class="status" data-status={d.status}
                    >{statusLabels[d.status as Status] ?? d.status}</span
                  ></td
                >
                <td>{d.owner}</td>
                <td
                  >{d.expected_on
                    ? dayLabel(d.expected_on)
                    : 'Sem prazo'}{#if d.overdue}{' '}<strong>vencido</strong
                    >{/if}</td
                >
                <td
                  >{d.remaining_minutes === null
                    ? 'Sem estimativa'
                    : hoursLabel(d.remaining_minutes)}</td
                >
                <td>{d.covered ? 'Coberta' : 'Pendente'}</td>
              </tr>{/each}
          </tbody>
        </table>
      </div>
    {/if}
    {#if overview.scopes.length}
      <h3>Escopos em andamento</h3>
      <ul class="plain">
        {#each overview.scopes as s (s.id)}<li>
            {s.project_name} · V{s.number} · {s.title}:
            <strong>{s.state === 'draft' ? 'Rascunho' : 'Submetido'}</strong>
          </li>{/each}
      </ul>
    {/if}
  </section>
{:else if overview?.kind === 'personal'}
  <section class="panel exec" aria-label="Meus apontamentos">
    <p class="eyebrow">MEU TRABALHO</p>
    <h2>
      {mine === 1
        ? '1 demanda sua em aberto'
        : mine
          ? `${mine} demandas suas em aberto`
          : 'Nenhuma demanda sua em aberto'}
    </h2>
    <ul class="health-legend" aria-label="Minhas horas">
      <li>Aprovadas <strong>{hoursLabel(overview.hours.approved)}</strong></li>
      <li>
        Pendentes de decisão <strong
          >{hoursLabel(overview.hours.pending)}</strong
        >
      </li>
      <li>Rejeitadas <strong>{hoursLabel(overview.hours.rejected)}</strong></li>
    </ul>
    {#if overview.rejected.length}
      <p class="attention">
        <strong>Corrija:</strong>
        {overview.rejected.length} apontamento(s) rejeitado(s):
        {overview.rejected
          .map((t) => `${dayLabel(t.work_date)} · ${hoursLabel(t.minutes)}`)
          .join('; ')}.
        <a href={href('economia', { painel: 'apontar' })}
          >Corrigir apontamento</a
        >
      </p>
    {:else}<p class="muted">
        Use “Apontar horas nesta demanda” em cada prioridade: projeto e demanda
        já vêm preenchidos.
      </p>{/if}
  </section>
{/if}
