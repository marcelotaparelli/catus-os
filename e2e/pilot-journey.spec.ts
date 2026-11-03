import { test, expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { login } from './login';
import { open } from './nav';

// Controlled-pilot acceptance: one synthetic operation carried end to end through the
// real UI by four roles. Inputs mirror e2e/economics.spec.ts (which builds them via API),
// so identical financial results cross-check the UI path against the API path.
// Isolation from other specs sharing the harness DB: USD and October 2026 periods.
const run = Date.now().toString(36).toUpperCase();
const CLIENT = `PILOTO ${run} Cliente Sintético`;
const PROJECT = `PILOTO ${run} Loja Sintética`;
const CONTRACT = `PILOTO ${run} Contrato Sintético`;
const MEETING = `SYNTHETIC PILOT ${run} reunião: checkout com abandono alto`;
const ITEM = `PILOTO ${run} checkout contratado`;
const REQUEST = `PILOTO ${run} Revisar checkout`;
const FROM = '2026-10-01',
  UNTIL = '2026-10-31';

function econ(page: Page) {
  return page.getByRole('region', { name: 'Inteligência econômica' });
}
function commercial(page: Page) {
  return page.getByRole('region', { name: 'Controle comercial' });
}
function card(page: Page) {
  return page.locator('article.request').filter({
    has: page.getByRole('heading', { name: REQUEST, exact: true }),
  });
}
async function openDetails(region: Locator, summary: string) {
  const details = region.locator('details').filter({
    has: region.page().getByText(summary, { exact: true }),
  });
  if (!(await details.first().evaluate((d) => (d as HTMLDetailsElement).open)))
    await region.getByText(summary, { exact: true }).click();
}
async function prepareEconomic(
  page: Page,
  kind: string,
  source: string,
  fill: (form: Locator) => Promise<void>,
  period = true,
) {
  await open(page, 'Economia');
  const e = econ(page);
  await e.getByRole('button', { name: 'Atualizar economia' }).click();
  await openDetails(e, 'Preparar premissas e estimativas');
  const form = e.getByRole('form', { name: 'Preparar registro econômico' });
  await form
    .getByRole('combobox', { name: 'Tipo de registro econômico', exact: true })
    .selectOption(kind);
  if (!['config', 'rate'].includes(kind))
    await form
      .getByRole('combobox', { name: 'Projeto econômico', exact: true })
      .selectOption({ label: PROJECT });
  await form
    .getByRole('combobox', { name: 'Moeda econômica', exact: true })
    .selectOption('USD');
  if (period) {
    await form.getByLabel('Início da competência/vigência').fill(FROM);
    await form.getByLabel('Fim da competência/vigência').fill(UNTIL);
  }
  await form.getByLabel('Fonte das premissas').fill(source);
  await fill(form);
  await form.getByRole('button', { name: 'Preparar versão econômica' }).click();
  await expect(e.getByRole('status')).toContainText('Versão preparada');
}
async function approveEconomic(page: Page, source: string) {
  await open(page, 'Economia');
  const e = econ(page);
  await e.getByRole('button', { name: 'Atualizar economia' }).click();
  await openDetails(e, 'Versões e decisões econômicas');
  await e
    .getByLabel('Justificativa econômica de decisão/reversão')
    .fill(`Conferência independente ${source}`);
  const record = e.locator('article').filter({ hasText: source });
  await record.getByRole('button', { name: /^Aprovar registro/ }).click();
  await expect(record).toContainText('Aprovado');
}
async function editRequest(
  page: Page,
  values: { status?: string; owner?: string; action?: string },
) {
  await open(page, 'Solicitações');
  const c = card(page);
  await c.getByRole('button', { name: 'Atualizar solicitação' }).click();
  const edit = c.getByRole('region', { name: 'Editar solicitação' });
  if (values.status)
    await edit
      .getByRole('combobox', { name: 'Estado', exact: true })
      .selectOption(values.status);
  if (values.owner)
    await edit
      .getByRole('combobox', { name: 'Responsável', exact: true })
      .selectOption({ label: values.owner });
  if (values.action)
    await edit.getByLabel('Próxima ação', { exact: true }).fill(values.action);
  return edit;
}

test('controlled pilot: PO intake → owner → scope/contract → approvals → developer hours → manager economics → consistent Mission Control and audit', async ({
  page,
  browser,
}) => {
  test.setTimeout(180000);
  const errors: string[] = [];
  const adminCtx = await browser.newContext(),
    managerCtx = await browser.newContext(),
    devCtx = await browser.newContext();
  const contexts = [adminCtx, managerCtx, devCtx];
  try {
    const admin = await adminCtx.newPage(),
      manager = await managerCtx.newPage(),
      dev = await devCtx.newPage();
    for (const p of [page, admin, manager, dev])
      p.on('pageerror', (e) => errors.push(e.message));
    const po = page;
    await login(po, 'po@browser.test');
    await login(admin, 'admin@browser.test');
    await login(manager, 'manager@browser.test');
    await login(dev, 'dev@browser.test');

    // Role-aware navigation: modules are reachable, privileged entries are hidden.
    const poNav = po.getByRole('navigation', { name: 'Módulos', exact: true });
    await expect(
      poNav.getByRole('link', { name: 'Atendimento inteligente' }),
    ).toBeVisible();
    await expect(poNav.getByRole('link', { name: 'Auditoria' })).toHaveCount(0);
    await expect(
      poNav.getByRole('link', { name: 'Acesso e usuários' }),
    ).toHaveCount(0);
    const devNav = dev.getByRole('navigation', {
      name: 'Módulos',
      exact: true,
    });
    await expect(
      devNav.getByRole('link', { name: 'Atendimento inteligente' }),
    ).toHaveCount(0);
    await expect(
      manager
        .getByRole('navigation', { name: 'Módulos', exact: true })
        .getByRole('link', { name: 'Auditoria' }),
    ).toBeVisible();

    // 1. Admin sets the commercial approval authority (manager/admin decide).
    await open(admin, 'Comercial');
    const ac = commercial(admin);
    await ac
      .getByText('Configurar alçadas comerciais', { exact: true })
      .click();
    await ac.getByRole('button', { name: 'Salvar alçadas' }).click();
    await expect(ac.getByRole('status')).toContainText('Política v');

    // 2. PO records client, project and the meeting.
    await open(po, 'Clientes e projetos');
    await po.getByLabel('Nome do cliente', { exact: true }).fill(CLIENT);
    await po.getByRole('button', { name: 'Cadastrar cliente' }).click();
    await expect(po.getByRole('status').last()).toContainText('Registro salvo');
    await po
      .getByRole('combobox', { name: 'Cliente', exact: true })
      .selectOption({ label: CLIENT });
    await po.getByLabel('Nome do projeto', { exact: true }).fill(PROJECT);
    await po
      .getByRole('button', { name: 'Criar projeto', exact: true })
      .click();
    await po
      .getByRole('combobox', { name: 'Projeto', exact: true })
      .selectOption({ label: `${CLIENT} / ${PROJECT}` });
    await po
      .getByRole('combobox', { name: 'Tipo', exact: true })
      .selectOption('meeting');
    await po.getByLabel('Resumo e contexto').fill(MEETING);
    await po
      .getByRole('button', { name: 'Registrar atendimento', exact: true })
      .click();
    // Consultation: the meeting is visible in the client/project directory.
    const directory = po.getByRole('region', { name: 'Clientes e projetos' });
    await expect(directory).toContainText(CLIENT);
    await directory.getByText(PROJECT, { exact: false }).click();
    await expect(directory).toContainText(MEETING);
    await expect(directory).toContainText('Reunião');

    // 3. PO creates the request with an explicit owner and next action.
    const origin = po.getByRole('combobox', {
      name: 'Atendimento de origem',
      exact: true,
    });
    await origin.selectOption(
      (await origin
        .locator('option')
        .filter({ hasText: `SYNTHETIC PILOT ${run}` })
        .getAttribute('value'))!,
    );
    await po.getByLabel('Título', { exact: true }).fill(REQUEST);
    await po
      .getByLabel('Descrição', { exact: true })
      .fill('Investigar abandono no checkout da loja sintética');
    await po
      .getByRole('combobox', { name: 'Responsável', exact: true })
      .selectOption({ label: 'Dev Browser · dev@browser.test' });
    await po
      .getByLabel('Próxima ação', { exact: true })
      .fill('Confirmar escopo comercial');
    await po
      .getByRole('button', { name: 'Criar solicitação', exact: true })
      .click();
    await open(po, 'Solicitações');
    await expect(card(po)).toContainText('Nova');
    await expect(card(po)).toContainText('Dev Browser');
    await expect(card(po)).toContainText('Pendente de análise comercial');

    // 4. Contract (PO registers, manager activates) and scope V1 (PO prepares, manager approves).
    await open(po, 'Comercial');
    const pc = commercial(po);
    await pc.getByText('Cadastrar contrato', { exact: true }).click();
    await pc
      .getByRole('combobox', { name: 'Projeto contratual', exact: true })
      .selectOption({ label: PROJECT });
    await pc.getByLabel('Título do contrato').fill(CONTRACT);
    await pc
      .getByRole('combobox', { name: 'Moeda', exact: true })
      .selectOption('USD');
    await pc.getByLabel('Vigência inicial (UTC)').fill('2020-01-01');
    await pc.getByLabel('Vigência final (UTC)').fill('2099-12-31');
    await pc.getByLabel('Referência documental').fill(`SYNTHETIC-PILOT-${run}`);
    await pc
      .getByRole('button', { name: 'Registrar contrato', exact: true })
      .click();
    await open(manager, 'Comercial');
    const mc = commercial(manager);
    await mc.getByRole('button', { name: 'Atualizar comercial' }).click();
    const contract = mc.locator('article').filter({
      has: manager.getByRole('heading', { name: CONTRACT, exact: true }),
    });
    await contract
      .getByRole('button', { name: 'Registrar contrato como ativo' })
      .click();
    await expect(contract).toContainText('Ativo');

    await pc.getByRole('button', { name: 'Atualizar comercial' }).click();
    await pc.getByRole('button', { name: 'Preparar escopo inicial' }).click();
    const scopeForm = po.getByRole('form', {
      name: 'Preparar versão de escopo',
    });
    await scopeForm
      .getByRole('combobox', { name: 'Projeto do escopo', exact: true })
      .selectOption({ label: PROJECT });
    await scopeForm
      .getByRole('combobox', { name: 'Contrato do escopo', exact: true })
      .selectOption({ label: CONTRACT });
    await scopeForm.getByLabel('Título da versão').fill('Piloto V1');
    await scopeForm.getByLabel('Descrição do item', { exact: true }).fill(ITEM);
    await scopeForm
      .getByLabel('Entregáveis', { exact: true })
      .fill('Checkout revisado');
    await scopeForm
      .getByLabel('Exclusões', { exact: true })
      .fill('Meios de pagamento externos');
    await scopeForm
      .getByLabel('Critérios de aceite contratual', { exact: true })
      .fill('Pedido sintético concluído');
    await scopeForm
      .getByLabel('Dependências', { exact: true })
      .fill('Acesso ao tema sintético');
    const scopeOrigin = scopeForm.getByRole('combobox', {
      name: 'Atendimento de origem comercial',
      exact: true,
    });
    await scopeOrigin.selectOption(
      (await scopeOrigin
        .locator('option')
        .filter({ hasText: `SYNTHETIC PILOT ${run}` })
        .getAttribute('value'))!,
    );
    await scopeForm
      .getByRole('button', { name: 'Salvar rascunho de escopo' })
      .click();
    const detail = pc.getByLabel('Detalhe do escopo', { exact: true });
    await detail.getByRole('button', { name: 'Submeter escopo' }).click();
    await expect(detail).toContainText('Submetido');
    // The preparer has no decision control in the UI.
    await expect(
      detail.getByRole('button', { name: 'Aprovar escopo' }),
    ).toHaveCount(0);
    await expect(detail).toContainText('Preparador: PO Browser');
    await expect(detail).toContainText(`Atendimento: SYNTHETIC PILOT ${run}`);

    await mc.getByRole('button', { name: 'Atualizar comercial' }).click();
    const version = mc.getByRole('combobox', {
      name: 'Versão de escopo',
      exact: true,
    });
    await version.selectOption(
      (await version
        .locator('option')
        .filter({ hasText: `${PROJECT} · V1 ·` })
        .getAttribute('value'))!,
    );
    await mc
      .getByLabel('Justificativa da decisão')
      .fill('Escopo sintético do piloto conferido');
    await mc
      .getByRole('button', { name: 'Aprovar escopo', exact: true })
      .click();
    const managerDetail = mc.getByLabel('Detalhe do escopo', { exact: true });
    await expect(managerDetail).toContainText('Estado comercial: Aprovado');
    await expect(managerDetail).toContainText('por Gestor Browser');

    // 5. PO links coverage and triages the request to ready.
    await pc.getByRole('button', { name: 'Atualizar comercial' }).click();
    const coverage = pc.getByRole('form', {
      name: 'Revisar cobertura comercial',
    });
    await coverage
      .getByRole('combobox', { name: 'Demanda para cobertura', exact: true })
      .selectOption({ label: REQUEST });
    await coverage
      .getByRole('combobox', { name: 'Item de escopo aprovado', exact: true })
      .selectOption({ label: `V1 · ${ITEM}` });
    await coverage.getByRole('button', { name: 'Confirmar cobertura' }).click();
    await open(po, 'Solicitações');
    await expect(card(po)).toContainText('Cobertura comercial aprovada');
    await expect(card(po)).toContainText(`Escopo V1 · ${CONTRACT}`);
    for (const [status, action] of [
      ['triage', 'Detalhar estimativa'],
      ['ready', 'Iniciar implementação'],
    ]) {
      const edit = await editRequest(po, { status, action });
      await edit.getByRole('button', { name: 'Salvar atualização' }).click();
      await expect(edit).toHaveCount(0);
    }
    await expect(card(po)).toContainText('Pronta');

    // 5b. Concurrent edit: manager saves first; the PO's stale form is refreshed, not lost-updated.
    await manager.getByRole('button', { name: 'Atualizar dados' }).click();
    const poEdit = await editRequest(po, {
      action: 'Texto desatualizado do PO',
    });
    const managerEdit = await editRequest(manager, {
      action: 'Iniciar implementação com prioridade',
    });
    await managerEdit
      .getByRole('button', { name: 'Salvar atualização' })
      .click();
    await expect(managerEdit).toHaveCount(0);
    await poEdit.getByRole('button', { name: 'Salvar atualização' }).click();
    await expect(po.getByRole('alert')).toContainText(
      'Outra pessoa alterou esta solicitação',
    );
    await expect(
      card(po)
        .getByRole('region', { name: 'Editar solicitação' })
        .getByLabel('Próxima ação', { exact: true }),
    ).toHaveValue('Iniciar implementação com prioridade');
    await card(po).getByRole('button', { name: 'Cancelar' }).click();

    // 6. Manager prepares economic premises; admin approves independently.
    await prepareEconomic(
      manager,
      'config',
      `PILOT-${run}-CONFIG`,
      async (f) => {
        await f.getByLabel('Tributos em pontos-base').fill('1000');
        await f.getByLabel('Comissões em pontos-base').fill('500');
        await f
          .getByRole('combobox', { name: 'Regra de overhead', exact: true })
          .selectOption('per_labor_minute');
        await f
          .getByLabel('Overhead por hora em unidades mínimas')
          .fill('1200');
        await expect(f.locator('.money-preview').first()).toHaveText(
          '= USD 12,00',
        );
        await f
          .getByLabel('Dias de trabalho ISO separados por vírgula')
          .fill('1,2,3,4,5');
        await f.getByLabel('Minutos de trabalho por dia').fill('480');
      },
    );
    await approveEconomic(admin, `PILOT-${run}-CONFIG`);
    await prepareEconomic(manager, 'rate', `PILOT-${run}-RATE`, async (f) => {
      await f
        .getByRole('combobox', { name: 'Profissional econômico', exact: true })
        .selectOption({ label: 'Dev Browser · dev@browser.test' });
      await f.getByLabel('Custo por hora em unidades mínimas').fill('6000');
      await expect(f.getByText('= USD 60,00')).toBeVisible();
    });
    await approveEconomic(admin, `PILOT-${run}-RATE`);
    await prepareEconomic(manager, 'terms', `PILOT-${run}-TERMS`, async (f) => {
      await f
        .getByRole('combobox', { name: 'Contrato econômico', exact: true })
        .selectOption({ label: `${CONTRACT} · Preço fechado` });
      await f
        .getByRole('combobox', {
          name: 'Escopo aprovado dos termos',
          exact: true,
        })
        .selectOption({ label: 'V1 · Piloto V1' });
      await f
        .getByLabel('Valor contratado na competência em unidades mínimas')
        .fill('1000000');
      await f
        .getByRole('combobox', { name: 'Regra de reconhecimento', exact: true })
        .selectOption('manual');
      await f
        .getByLabel('Receita reconhecida em unidades mínimas')
        .fill('400000');
      await f.getByLabel('Custos externos estão completos').check();
      await f.getByLabel('Apontamentos estão completos').check();
      await f
        .getByRole('combobox', { name: 'Regra de excedente', exact: true })
        .selectOption('none');
      await f
        .getByRole('combobox', { name: 'Regra de rollover', exact: true })
        .selectOption('none');
      await f.getByLabel('Teto de rollover em minutos').fill('0');
      await f.getByLabel('Entrada de rollover em minutos').fill('0');
    });
    await approveEconomic(admin, `PILOT-${run}-TERMS`);
    await prepareEconomic(
      manager,
      'capacity',
      `PILOT-${run}-CAPACITY`,
      async (f) => {
        await f
          .getByRole('combobox', {
            name: 'Profissional econômico',
            exact: true,
          })
          .selectOption({ label: 'Dev Browser · dev@browser.test' });
        await f
          .getByLabel('Capacidade disponível alocada em minutos')
          .fill('1000');
      },
    );
    await approveEconomic(admin, `PILOT-${run}-CAPACITY`);
    await prepareEconomic(
      manager,
      'direct_cost',
      `PILOT-${run}-DIRECT`,
      async (f) => {
        const t = f.getByRole('combobox', {
          name: 'Termos aprovados para planejamento',
          exact: true,
        });
        await t.selectOption(
          (await t
            .locator('option')
            .filter({ hasText: PROJECT })
            .getAttribute('value'))!,
        );
        await f.getByLabel('Referência única da despesa').fill(`PILOT-${run}`);
        await f
          .getByRole('combobox', {
            name: 'Classificação de despesa',
            exact: true,
          })
          .selectOption('external');
        await f
          .getByLabel('Orçamento da despesa em unidades mínimas')
          .fill('20000');
        await f
          .getByLabel('Parcela incorrida em unidades mínimas')
          .fill('5000');
        await f
          .getByLabel('Parcela para concluir em unidades mínimas')
          .fill('15000');
      },
      false,
    );
    await approveEconomic(admin, `PILOT-${run}-DIRECT`);

    // 7. PO estimates effort without seeing rates; manager approves.
    await po.getByRole('button', { name: 'Atualizar dados' }).click();
    await prepareEconomic(
      po,
      'estimate',
      `PILOT-${run}-ESTIMATE`,
      async (f) => {
        await expect(
          f.getByRole('combobox', { name: 'Tipo de registro econômico' }),
        ).not.toContainText('Custo por hora');
        const t = f.getByRole('combobox', {
          name: 'Termos aprovados para planejamento',
          exact: true,
        });
        await t.selectOption(
          (await t
            .locator('option')
            .filter({ hasText: PROJECT })
            .getAttribute('value'))!,
        );
        await f
          .getByRole('combobox', {
            name: 'Profissional econômico',
            exact: true,
          })
          .selectOption({ label: 'Dev Browser · dev@browser.test' });
        await f
          .getByRole('combobox', { name: 'Demanda a estimar', exact: true })
          .selectOption({ label: REQUEST });
        await f.getByLabel('Baseline prevista em minutos').fill('600');
        await f.getByLabel('Minutos para concluir').fill('1200');
        await f.getByLabel('Data prevista de conclusão').fill('2026-10-30');
      },
      false,
    );
    await approveEconomic(manager, `PILOT-${run}-ESTIMATE`);

    // 8. Developer finds own work, starts it and logs hours.
    await dev.getByRole('button', { name: 'Atualizar dados' }).click();
    // Mission Control lists the developer's own priority with its next action.
    await expect(
      dev.getByRole('region', { name: 'Minhas prioridades' }),
    ).toContainText(REQUEST);
    await open(dev, 'Solicitações');
    await dev
      .getByRole('combobox', { name: 'Filtrar responsável', exact: true })
      .selectOption('me');
    // The filter is part of the URL, so it survives reload and back/forward.
    await expect(dev).toHaveURL(/#\/solicitacoes\?responsavel=me$/);
    await expect(card(dev)).toContainText('você');
    const devEdit = await editRequest(dev, {
      status: 'in_progress',
      action: 'Implementar correção e testes do checkout',
    });
    await expect(
      devEdit.getByRole('combobox', { name: 'Responsável', exact: true }),
    ).toBeDisabled();
    await devEdit.getByRole('button', { name: 'Salvar atualização' }).click();
    await expect(card(dev)).toContainText('Em execução');
    await open(dev, 'Economia');
    const de = econ(dev);
    await de.getByText('Apontar horas próprias', { exact: true }).click();
    const hours = de.getByRole('form', { name: 'Apontar horas próprias' });
    await hours
      .getByRole('combobox', { name: 'Projeto das horas', exact: true })
      .selectOption({ label: PROJECT });
    await hours
      .getByRole('combobox', { name: 'Demanda das horas', exact: true })
      .selectOption({ label: REQUEST });
    await hours.getByLabel('Data trabalhada').fill('2026-10-15');
    await hours.getByLabel('Duração em minutos').fill('120');
    await hours
      .getByLabel('Comentário do apontamento')
      .fill(`PILOT ${run} developer 120 minutes`);
    await hours.getByRole('button', { name: 'Registrar minutos' }).click();
    await expect(de.getByRole('status')).toContainText('Horas pendentes');
    const devEconomics = JSON.stringify(
      await (await dev.request.get('/api/economics')).json(),
    );
    for (const secret of [
      'minor_per_hour',
      'cost_minor',
      'tax_bps',
      'recognized_minor',
    ])
      expect(devEconomics).not.toContain(secret);

    // 9. Manager approves the hours (by name) and calculates profitability.
    await open(manager, 'Economia');
    const me = econ(manager);
    await me.getByRole('button', { name: 'Atualizar economia' }).click();
    await me
      .getByLabel('Justificativa econômica de decisão/reversão')
      .fill('Minutos do piloto conferidos');
    await openDetails(me, 'Horas e decisões');
    const entry = me.locator('article').filter({
      has: manager.getByRole('heading', {
        name: `PILOT ${run} developer 120 minutes`,
        exact: true,
      }),
    });
    await expect(entry).toContainText('Dev Browser');
    await entry.getByRole('button', { name: /^Aprovar horas/ }).click();
    await expect(entry).toContainText('Aprovadas');
    const reportForm = me.getByRole('form', {
      name: 'Calcular observação econômica',
    });
    const reportTerms = reportForm.getByRole('combobox', {
      name: 'Termos para relatório',
      exact: true,
    });
    await reportTerms.selectOption(
      (await reportTerms
        .locator('option')
        .filter({ hasText: PROJECT })
        .getAttribute('value'))!,
    );
    await reportForm.getByLabel('Data de corte das horas').fill(UNTIL);
    await reportForm
      .getByRole('button', { name: 'Calcular e preservar' })
      .click();
    const report = me
      .getByRole('article', { name: /^Relatório econômico/ })
      .filter({ hasText: PROJECT });
    // Same inputs as the API-built M4 suite must give identical deterministic figures.
    await expect(report).toContainText('USD 10000,00');
    await expect(report).toContainText('USD 3284,00');
    await expect(report).toContainText('USD 6716,00');
    await expect(report).toContainText('EAC acima do orçamento');
    await expect(report).toContainText('600 / 120 / 0 / 1200');
    await expect(report).toContainText('1000 minutos');
    await expect(report).not.toContainText('incompleta');

    // 10. Mission Control shows one consistent state for every role.
    for (const p of [po, manager, dev]) {
      await open(p, 'Solicitações');
      await p.reload();
      const c = card(p);
      await expect(c).toContainText('Em execução');
      await expect(c).toContainText('Dev Browser');
      await expect(c).toContainText(
        'Implementar correção e testes do checkout',
      );
      await expect(c).toContainText(`Cobertura comercial aprovada`);
      await expect(c).toContainText(`Escopo V1 · ${CONTRACT}`);
      await expect(c).toContainText(MEETING);
    }
    await open(dev, 'Mission Control');
    await expect(
      dev
        .getByRole('region', { name: 'Resumo operacional' })
        .locator('div')
        .filter({ hasText: 'Atribuídas a mim' }),
    ).toContainText(/[1-9]/);
    await manager.reload();
    await open(manager, 'Economia');
    await expect(
      econ(manager)
        .getByRole('article', { name: /^Relatório econômico/ })
        .filter({ hasText: PROJECT }),
    ).toContainText('USD 3284,00');

    // 11. Audit trail: manager sees who did what; PO cannot read it.
    await open(manager, 'Auditoria');
    const audit = manager.getByRole('region', { name: 'Auditoria' });
    await audit.getByRole('button', { name: 'Carregar auditoria' }).click();
    await audit
      .getByRole('combobox', { name: 'Tipo de registro', exact: true })
      .selectOption('request');
    await expect(audit.locator('tbody')).toContainText('PO Browser');
    await expect(audit.locator('tbody')).toContainText('Dev Browser');
    await expect(audit.locator('tbody')).toContainText('ready->in_progress');
    expect((await po.request.get('/api/audit')).status()).toBe(403);

    // 12. Developer cannot create operational records, even by calling the API directly.
    const session = await (await dev.request.get('/api/session')).json();
    expect(
      (
        await dev.request.post('/api/requests', {
          headers: {
            Origin: 'http://127.0.0.1:5173',
            'X-CSRF-Token': session.csrfToken,
            'Idempotency-Key': crypto.randomUUID(),
          },
          data: {
            interaction_id: crypto.randomUUID(),
            title: 'x',
            description: 'x',
            owner_user_id: session.user.id,
            next_action: 'x',
          },
        })
      ).status(),
    ).toBe(403);

    await manager.screenshot({
      path: 'test-results/pilot-journey-manager.png',
      fullPage: true,
    });
    await dev.setViewportSize({ width: 390, height: 844 });
    await expect(
      dev.getByRole('navigation', { name: 'Módulos (compacto)' }),
    ).toBeVisible();
    expect(
      await dev.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await dev.screenshot({
      path: 'test-results/pilot-journey-dev-mobile.png',
      fullPage: false,
    });
    expect(errors).toEqual([]);
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});
