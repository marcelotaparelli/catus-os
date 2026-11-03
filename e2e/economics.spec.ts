import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { login } from './login';
import { open } from './nav';
async function write(page: Page, path: string, body: unknown) {
  const session = await (await page.request.get('/api/session')).json();
  const response = await page.request.post('/api/' + path, {
    headers: {
      Origin: 'http://127.0.0.1:5173',
      'X-CSRF-Token': session.csrfToken,
      'Idempotency-Key': crypto.randomUUID(),
    },
    data: body,
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
test('M4 manager prepares explicit assumptions, PO estimates, developer logs hours privately, independent approval and traceable EAC/margin risk', async ({
  page,
  browser,
}) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await login(page, 'manager@browser.test');
  const adminContext = await browser.newContext(),
    poContext = await browser.newContext(),
    devContext = await browser.newContext();
  try {
    const admin = await adminContext.newPage(),
      po = await poContext.newPage(),
      dev = await devContext.newPage();
    await login(admin, 'admin@browser.test');
    await login(po, 'po@browser.test');
    const cv = await (await admin.request.get('/api/commercial')).json();
    if (!cv.policy)
      await write(admin, 'commercial/policy', {
        version: 0,
        approval_roles: ['manager', 'administrator'],
      });
    const members = await (await po.request.get('/api/members')).json(),
      developer = members.find(
        (m: { email: string }) => m.email === 'dev@browser.test',
      ).id;
    const client = await write(po, 'clients', { name: 'M4 Cliente Sintético' }),
      project = await write(po, 'projects', {
        client_id: client.id,
        name: 'M4 Projeto Sintético',
      }),
      interaction = await write(po, 'interactions', {
        project_id: project.id,
        kind: 'meeting',
        summary: 'SYNTHETIC M4 economics scope',
        occurred_at: '2026-11-01T10:00:00Z',
      });
    const contract = await write(po, 'contracts', {
      project_id: project.id,
      client_id: client.id,
      title: 'M4 Contrato Sintético',
      kind: 'fixed_price',
      currency: 'BRL',
      valid_from: '2020-01-01',
      valid_until: '2099-12-31',
      document_reference: 'SYNTHETIC-E2E-M4-CONTRACT',
    });
    const session = await (await page.request.get('/api/session')).json();
    expect(
      (
        await page.request.patch('/api/contracts/' + contract.id, {
          headers: {
            Origin: 'http://127.0.0.1:5173',
            'X-CSRF-Token': session.csrfToken,
          },
          data: { version: 1, state: 'active' },
        })
      ).status(),
    ).toBe(200);
    const scope = await write(po, 'scopes', {
      project_id: project.id,
      contract_id: contract.id,
      title: 'M4 Escopo Sintético',
      items: [
        {
          description: 'Checkout sintético M4',
          deliverables: 'Checkout',
          exclusions: 'Real data',
          acceptance_criteria: 'Synthetic tests',
          dependencies: 'None declared',
          origin_interaction_id: interaction.id,
          origin_request_id: null,
        },
      ],
    });
    await write(po, 'scopes/' + scope.id + '/submit', { version: 1 });
    await write(page, 'scopes/' + scope.id + '/decide', {
      version: 2,
      decision: 'approved',
      reason: 'Independent synthetic approval',
    });
    const request = await write(po, 'requests', {
      interaction_id: interaction.id,
      title: 'M4 Demanda Sintética',
      description: 'Synthetic M4 work',
      owner_user_id: developer,
      next_action: 'Estimate',
    });
    await write(po, 'requests/' + request.id + '/coverage', {
      version: 1,
      scope_item_id: scope.items[0].id,
    });
    await open(page, 'Economia');
    const econ = page.getByRole('region', { name: 'Inteligência econômica' });
    await econ.getByRole('tab', { name: 'Preparar' }).click();
    const form = econ.getByRole('form', {
      name: 'Preparar registro econômico',
    });
    await form.getByRole('radio', { name: /^Premissas econômicas/ }).check();
    await form.getByLabel('Início da competência/vigência').fill('2026-01-01');
    await form.getByLabel('Fim da competência/vigência').fill('2026-12-31');
    await form
      .getByLabel('Fonte das premissas')
      .fill('SYNTHETIC-E2E-M4-CONFIG');
    await form.getByLabel('Tributos (%)').fill('10');
    await form.getByLabel('Comissões (%)').fill('5');
    await form
      .getByRole('combobox', { name: 'Regra de overhead', exact: true })
      .selectOption('per_labor_minute');
    await form.getByLabel('Overhead por hora (BRL)').fill('12,00');
    await form
      .getByRole('button', { name: 'Preparar versão econômica' })
      .click();
    await expect(econ.getByRole('status')).toContainText('Versão preparada');
    await open(admin, 'Economia');
    const ae = admin.getByRole('region', { name: 'Inteligência econômica' });
    await ae.getByRole('button', { name: 'Atualizar economia' }).click();
    await ae
      .getByLabel('Justificativa econômica de decisão/reversão')
      .fill('Premissas sintéticas conferidas independentemente');
    const configCard = ae
      .locator('article')
      .filter({ hasText: 'SYNTHETIC-E2E-M4-CONFIG' });
    // The values are read on the card, in human units, before deciding.
    await expect(configCard).toContainText('10,00%');
    await expect(configCard).toContainText('BRL 12,00 por hora');
    await configCard.getByRole('button', { name: /^Aprovar registro/ }).click();
    await expect(ae.getByRole('status')).toContainText('decisão registrada');
    await expect(configCard).toHaveCount(0);
    const approve = async (r: { id: string; revision: number }) =>
      write(admin, 'economics/records/' + r.id + '/decide', {
        revision: r.revision,
        decision: 'approved',
        reason: 'Synthetic source checked',
      });
    const prep = async (
      kind: string,
      payload: unknown,
      extra: Record<string, unknown> = {},
    ) => {
      const r = await write(page, 'economics/records', {
        kind,
        project_id: ['config', 'rate'].includes(kind) ? null : project.id,
        currency: 'BRL',
        valid_from: '2026-11-01',
        valid_until: '2026-11-30',
        source: 'SYNTHETIC-E2E-M4-' + kind,
        payload,
        previous_id: null,
        ...extra,
      });
      await approve(r);
      return r;
    };
    await prep('rate', {
      user_id: developer,
      role: null,
      minor_per_hour: '6000',
    });
    const terms = await prep('terms', {
      contract_id: contract.id,
      scope_id: scope.id,
      amount_minor: '1000000',
      recognition_rule: 'manual',
      recognized_minor: '400000',
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
    });
    await prep('capacity', { user_id: developer, available_minutes: 1000 });
    await prep('direct_cost', {
      terms_id: terms.id,
      expense_key: 'SYNTHETIC-E2E-M4-DIRECT',
      classification: 'external',
      budget_minor: '20000',
      incurred_minor: '5000',
      remaining_minor: '15000',
    });
    await po
      .getByRole('button', { name: 'Atualizar dados', exact: true })
      .click();
    await open(po, 'Economia');
    const pe = po.getByRole('region', { name: 'Inteligência econômica' });
    await pe.getByRole('button', { name: 'Atualizar economia' }).click();
    const pf = pe.getByRole('form', { name: 'Preparar registro econômico' });
    await pf
      .getByRole('combobox', { name: 'Demanda a estimar', exact: true })
      .selectOption(request.id);
    // Project, the only approved term and the owner all come from the demand.
    await expect(
      pf.getByRole('combobox', { name: 'Profissional econômico', exact: true }),
    ).toHaveValue(developer);
    await pf.getByLabel('Fonte das premissas').fill('SYNTHETIC-PO-FORECAST');
    await pf.getByLabel('Horas previstas').fill('10');
    await pf.getByLabel('Horas para concluir').fill('20');
    await pf.getByLabel('Data prevista de conclusão').fill('2026-11-20');
    await pf.getByRole('button', { name: 'Preparar versão econômica' }).click();
    await expect(pe.getByRole('status')).toContainText('Versão preparada');
    await ae.getByRole('button', { name: 'Atualizar economia' }).click();
    const forecast = ae
      .locator('article')
      .filter({ hasText: 'SYNTHETIC-PO-FORECAST' });
    await forecast.getByRole('button', { name: /^Aprovar registro/ }).click();
    await expect(forecast).toHaveCount(0);
    await login(dev, 'dev@browser.test');
    await open(dev, 'Economia');
    const de = dev.getByRole('region', { name: 'Inteligência econômica' });
    const df = de.getByRole('form', { name: 'Apontar horas próprias' });
    await df
      .getByRole('combobox', { name: 'Demanda das horas', exact: true })
      .selectOption(request.id);
    await df.getByLabel('Data trabalhada').fill('2026-11-01');
    await df.getByLabel('Duração (horas)').fill('2');
    await df
      .getByLabel('Comentário do apontamento')
      .fill('SYNTHETIC developer work 120 minutes');
    await df.getByRole('button', { name: 'Registrar horas' }).click();
    await expect(de.getByRole('status')).toContainText('Horas pendentes');
    const safe = JSON.stringify(
      await (await dev.request.get('/api/economics')).json(),
    );
    for (const secret of [
      'minor_per_hour',
      'cost_minor',
      'tax_bps',
      'recognized_minor',
    ])
      expect(safe).not.toContain(secret);
    await expect(
      de.getByRole('form', { name: 'Preparar registro econômico' }),
    ).toHaveCount(0);
    await econ.getByRole('button', { name: 'Atualizar economia' }).click();
    await econ.getByRole('tab', { name: /^Para decidir/ }).click();
    await econ
      .getByLabel('Justificativa econômica de decisão/reversão')
      .fill('Minutos sintéticos conferidos');
    const time = econ.locator('article').filter({
      has: page.getByRole('heading', {
        name: 'SYNTHETIC developer work 120 minutes',
        exact: true,
      }),
    });
    await time.getByRole('button', { name: /^Aprovar horas/ }).click();
    await expect(econ.getByRole('status')).toContainText('2h de');
    await expect(time).toHaveCount(0);
    await econ.getByRole('tab', { name: 'Horas' }).click();
    await expect(time).toContainText('Aprovadas');
    await econ.getByRole('tab', { name: 'Rentabilidade' }).click();
    const rf = econ.getByRole('form', {
      name: 'Calcular observação econômica',
    });
    await rf.getByLabel('Data de corte das horas').fill('2026-11-01');
    await rf
      .getByRole('button', { name: 'Calcular e preservar M4 Projeto' })
      .click();
    const report = econ
      .getByRole('article', { name: /^Relatório econômico/ })
      .first();
    await expect(report).toContainText('BRL 3.284,00');
    await expect(report).toContainText('BRL 6.716,00');
    await expect(report).toContainText('EAC acima do orçamento');
    await expect(report).toContainText('20h');
    await report
      .getByText('Fórmulas, premissas e fontes desta observação', {
        exact: true,
      })
      .click();
    await expect(report).toContainText('SYNTHETIC-PO-FORECAST');
    await expect(report).toContainText('SYNTHETIC-E2E-M4-CONFIG');
    await expect(report).toContainText('m4.1');
    await page.screenshot({
      path: 'test-results/m4-economics.png',
      fullPage: true,
    });
    await page.reload();
    await econ.getByRole('tab', { name: 'Rentabilidade' }).click();
    await expect(
      econ.getByRole('article', { name: /^Relatório econômico/ }).first(),
    ).toContainText('BRL 3.284,00');
    await open(page, 'Solicitações');
    await expect(
      page.getByRole('heading', { name: 'M4 Demanda Sintética', exact: true }),
    ).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await Promise.all([
      adminContext.close(),
      poContext.close(),
      devContext.close(),
    ]);
  }
});
