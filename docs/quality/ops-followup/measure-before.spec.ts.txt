import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Meter, api } from './support-ux/meter';
import { open } from './nav';
import type { Module } from './nav';
import { team, intake, demand, testDb, PEOPLE } from './support-ops/seed';
import type { Who } from './support-ops/seed';

// AS-IS audit of 75a9c14 in a real browser. Preserved under docs/quality/ops-followup.
test.use({ actionTimeout: 15000 });
const OUT = process.env.OPS_EVIDENCE ?? 'test-results/ops-audit';
mkdirSync(OUT, { recursive: true });
const TERMS: Record<string, RegExp> = {
  briefing: /briefing/i,
  proposta: /proposta comercial|proposta de/i,
  contrato: /contrato/i,
  escopo: /escopo/i,
  orcamento: /orçamento|orçad/i,
  estimativa: /estimativa/i,
  planejamento: /planejamento|cronograma|sprint/i,
  prioridade: /prioridade/i,
  prazo: /prazo|vencid|vencimento/i,
  qa: /\bQA\b|qualidade|homologa/i,
  aceite: /aceite/i,
  go_live: /go-live|publicação|publicar/i,
  suporte: /suporte/i,
  incidente: /incidente/i,
  sla: /\bSLA\b/i,
  comunicacao_cliente: /comunicar|comunicação com o cliente/i,
  aprendizado: /aprendizado|lições|retrospectiva/i,
};
const MODULES: Module[] = [
  'Mission Control',
  'Solicitações',
  'Clientes e projetos',
  'Comercial',
  'Economia',
];

test('AS-IS: capability probes by role and effort of the follow-up tasks', async ({
  browser,
}) => {
  test.setTimeout(300000);
  const { pages, ids } = await team(browser);
  const c = await intake(pages.po, 'Aurora (sintético)');
  const db = testDb();
  // Probes: which words of the agency's workflow exist on each screen, per role.
  const seen: Record<string, Record<string, string[]>> = {};
  for (const who of Object.keys(PEOPLE) as Who[]) {
    seen[who] = {};
    for (const m of MODULES) {
      await open(pages[who], m);
      const text = await pages[who].locator('main').innerText();
      seen[who]![m] = Object.entries(TERMS)
        .filter(([, re]) => re.test(text))
        .map(([k]) => k);
      if (who === 'po' || who === 'dev' || who === 'manager')
        await pages[who].screenshot({
          path: `${OUT}/${who}-${m.replaceAll(' ', '-')}.png`,
          fullPage: true,
        });
    }
  }
  const effort: Record<string, unknown> = {};
  const seedOf = (t: string, owner = ids.dev) =>
    demand(pages.po, c.id, t, owner);
  const edit = (
    page: (typeof pages)['po'],
    title: string,
  ): ReturnType<typeof page.locator> =>
    page.locator('article.request').filter({ hasText: title });

  // Task 1: register a simple maintenance demand on an existing service record.
  {
    const m = new Meter(),
      p = pages.po,
      t0 = Date.now();
    await open(p, 'Clientes e projetos');
    m.clicks += 1;
    const form = p.locator('form').filter({ hasText: '04 · Solicitação' });
    await m.select(form.getByLabel('Atendimento de origem'), {
      label: `Loja Aurora (sintético) · Atendimento de Aurora (sintético)`,
    });
    await m.fill(form.getByLabel('Título'), 'Corrigir frete na vitrine');
    await m.fill(form.getByLabel('Descrição'), 'Frete errado no carrinho');
    await m.select(form.getByLabel('Responsável'), ids.dev);
    await m.fill(form.getByLabel('Próxima ação'), 'Reproduzir o erro');
    await m.click(form.getByRole('button', { name: 'Criar solicitação' }));
    await expect(p.getByText('Registro salvo.')).toBeVisible();
    effort.registrar = {
      clicks: m.clicks,
      fields: m.fields,
      ms: Date.now() - t0,
      prazo_registrado: false,
    };
  }
  // Situation that must be noticed: one case of each signal.
  const stalled = await seedOf('Parada há dias');
  const unowned = await seedOf('Sem responsável');
  await seedOf('Sem cobertura em execução');
  const blockedClient = await seedOf('Aguardando cliente');
  await db.query(
    "UPDATE requests SET updated_at=now()-interval '12 days' WHERE id=$1",
    [stalled.id],
  );
  await db.query('UPDATE requests SET owner_user_id=NULL WHERE id=$1', [
    unowned.id,
  ]);
  await pages.po.reload();

  // Task 2: find what needs action, by what the screen can actually show.
  {
    const m = new Meter(),
      p = pages.po,
      t0 = Date.now();
    await open(p, 'Solicitações');
    m.clicks += 1;
    const cards = await p.locator('article.request').count();
    const text = await p.locator('#solicitacoes').innerText();
    await m.select(p.getByLabel('Filtrar responsável'), 'unassigned');
    await m.select(p.getByLabel('Filtrar responsável'), '');
    await m.select(p.getByLabel('Filtrar estado'), 'blocked');
    await m.select(p.getByLabel('Filtrar estado'), '');
    effort.localizar = {
      clicks: m.clicks,
      fields: m.fields,
      ms: Date.now() - t0,
      cartoes_para_ler: cards,
      sinais_na_tela: {
        sem_responsavel: true,
        bloqueada: true,
        sem_cobertura: /Pendente de análise comercial/.test(text),
        parada: false,
        vencida: false,
        atraso_cliente: false,
      },
      prazo_na_tela: /vencid|prazo/i.test(text),
    };
    await p.screenshot({ path: `${OUT}/po-fila-antes.png`, fullPage: true });
  }
  // Task 3: block because the client owes something, with a return date.
  {
    const m = new Meter(),
      p = pages.po,
      t0 = Date.now();
    const a = edit(p, 'Aguardando cliente');
    await m.click(a.getByRole('button', { name: 'Atualizar solicitação' }));
    const f = a.getByRole('region', { name: 'Editar solicitação' });
    await m.select(f.getByLabel('Estado'), 'triage');
    await m.click(f.getByRole('button', { name: 'Salvar atualização' }));
    await expect(p.getByText('Solicitação atualizada.')).toBeVisible();
    await m.click(a.getByRole('button', { name: 'Atualizar solicitação' }));
    await m.select(f.getByLabel('Estado'), 'blocked');
    await m.fill(
      f.getByLabel('Próxima ação'),
      'Cliente deve enviar credenciais; cobrar em 2 dias (texto livre)',
    );
    await m.click(f.getByRole('button', { name: 'Salvar atualização' }));
    await expect(p.getByText('Solicitação atualizada.')).toBeVisible();
    effort.bloquear = {
      clicks: m.clicks,
      fields: m.fields,
      ms: Date.now() - t0,
      motivo_estruturado: false,
      retorno_estruturado: false,
    };
    expect(blockedClient.id).toBeTruthy();
  }
  // Task 4: give an owner to a demand that lost it.
  {
    const m = new Meter(),
      p = pages.po,
      t0 = Date.now();
    const a = edit(p, 'Sem responsável');
    await m.click(a.getByRole('button', { name: 'Atualizar solicitação' }));
    const f = a.getByRole('region', { name: 'Editar solicitação' });
    await m.select(f.getByLabel('Responsável'), ids.po);
    await m.click(f.getByRole('button', { name: 'Salvar atualização' }));
    await expect(p.getByText('Solicitação atualizada.')).toBeVisible();
    effort.atribuir = { clicks: m.clicks, fields: m.fields, ms: Date.now() - t0 };
  }
  // Task 5: the full walk of one demand to done (PO triage, developer execution).
  {
    const m = new Meter(),
      t0 = Date.now();
    const title = 'Corrigir frete na vitrine';
    const step = async (who: Who, to: string) => {
      const p = pages[who];
      await open(p, 'Solicitações');
      m.clicks += 1;
      // The list does not refresh by itself: another role's change needs this click.
      await m.click(p.getByRole('button', { name: 'Atualizar dados' }));
      const a = edit(p, title);
      await m.click(a.getByRole('button', { name: 'Atualizar solicitação' }));
      const f = a.getByRole('region', { name: 'Editar solicitação' });
      await m.select(f.getByLabel('Estado'), to);
      await m.fill(f.getByLabel('Próxima ação'), `Seguir: ${to}`);
      await m.click(f.getByRole('button', { name: 'Salvar atualização' }));
      await expect(p.getByText('Solicitação atualizada.')).toBeVisible();
    };
    await pages.dev.reload();
    await step('po', 'triage');
    await step('po', 'ready');
    await step('dev', 'in_progress');
    await step('dev', 'done');
    effort.ciclo_completo = {
      clicks: m.clicks,
      fields: m.fields,
      ms: Date.now() - t0,
      etapas_manuais: 4,
    };
  }
  // No route, no table: what the data can answer about time per stage.
  const routes = await Promise.all(
    ['followup', 'sla', 'incidents', 'qa', 'notifications'].map(async (r) => [
      r,
      await pages.manager.evaluate(
        async (x) => (await fetch('/api/' + x)).status,
        r,
      ),
    ]),
  );
  const columns = (
    await db.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name='requests' ORDER BY ordinal_position",
    )
  ).rows.map((r) => r.column_name);
  writeFileSync(
    `${OUT}/as-is.json`,
    JSON.stringify(
      { probes: seen, effort, routes: Object.fromEntries(routes), columns },
      null,
      2,
    ),
  );
  await db.end();
  expect(await api(pages.dev, 'session')).toBeTruthy();
});
