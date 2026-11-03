import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { open } from './nav';
import {
  Meter,
  agency,
  api,
  demandToCover,
  demandToEstimate,
  distancePx,
  screenFacts,
  PENDING_RATE_SOURCE,
} from './support-ux/meter';

// The effort of each common task, measured in the browser: this suite fails if a change
// makes a task cost more than the limits below. Same scenario and rule as the "before"
// run preserved in docs/quality/ux-comercial-economia/measure-before.spec.ts.txt.
const EVIDENCE = process.env.UX_EVIDENCE ?? 'test-results/ux-tasks';
const shot = (page: Page, name: string) =>
  page.screenshot({ path: `${EVIDENCE}/${name}.png`, fullPage: true });
const results: Record<string, unknown> = {};
const econOf = (p: Page) =>
  p.getByRole('region', { name: 'Inteligência econômica' });
async function atMobile(page: Page, name: string) {
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
    `${name}: horizontal overflow at 390 px`,
  ).toBe(true);
  await shot(page, `${name}-390`);
  await page.setViewportSize({ width: 1280, height: 900 });
}
async function noSeriousAxe(page: Page, label: string) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(
    violations
      .filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))
      .map((v) => `${label}: ${v.id}`),
  ).toEqual([]);
}

test('common Comercial and Economia tasks stay within their measured effort', async ({
  browser,
}) => {
  test.setTimeout(240000);
  mkdirSync(EVIDENCE, { recursive: true });
  const errors: string[] = [];
  const { pages, people } = await agency(browser);
  const { manager, admin, po, dev } = pages;
  for (const p of [manager, admin, po, dev])
    p.on('pageerror', (e) => errors.push(e.message));

  for (const [role, p] of [
    ['gestor', manager],
    ['po', po],
    ['desenvolvedor', dev],
  ] as const) {
    await p.reload();
    await open(p, 'Economia');
    await p.waitForLoadState('networkidle');
    results[`tela-economia-${role}`] = await screenFacts(p);
    await shot(p, `after-economia-${role}-1280`);
    await noSeriousAxe(p, `economia ${role}`);
  }

  // Gestor: the buttons explain themselves instead of sitting disabled.
  {
    const econ = econOf(manager);
    const card = econ
      .locator('article')
      .filter({ hasText: 'Trabalho sintético 360 min há 5 dias' });
    await card.getByRole('button', { name: /^Aprovar horas/ }).click();
    await expect(econ.getByRole('alert')).toContainText(
      'Escreva a justificativa',
    );
    await expect(
      econ.getByLabel('Justificativa econômica de decisão/reversão'),
    ).toBeFocused();
    await shot(manager, 'after-gestor-justificativa-ausente-1280');
    // A person is named, never an identifier.
    await expect(
      card.getByRole('button', { name: /^Aprovar horas de Davi Dev: 6h em/ }),
    ).toBeVisible();
    await expect(
      econ.getByRole('button', { name: /[0-9a-f]{8}-/ }),
    ).toHaveCount(0);
  }

  // Gestor: decide pending hours, entering by the menu.
  {
    const m = new Meter(),
      econ = econOf(manager);
    const reason = econ.getByLabel(
      'Justificativa econômica de decisão/reversão',
    );
    const card = econ
      .locator('article')
      .filter({ hasText: 'Trabalho sintético 360 min há 5 dias' });
    const button = card.getByRole('button', { name: /^Aprovar horas/ });
    const facts = await screenFacts(manager);
    const distance = await distancePx(reason, button);
    await m.fill(reason, 'Horas conferidas');
    await shot(manager, 'after-gestor-horas-1280');
    await atMobile(manager, 'after-gestor-horas');
    await m.click(button);
    await expect(econ.getByRole('status')).toContainText('decisão registrada');
    await expect(card).toHaveCount(0);
    results['gestor-decidir-horas'] = {
      clicks: m.clicks,
      fields: m.fields,
      distanceReasonToButtonPx: distance,
      ...facts,
    };
    expect(m.clicks).toBeLessThanOrEqual(1);
    await reason.fill('');
  }

  // Gestor: why can't I approve what I prepared?
  {
    const econ = econOf(manager);
    const card = econ
      .locator('article')
      .filter({ hasText: PENDING_RATE_SOURCE });
    await expect(card).toContainText('Você preparou esta versão');
    results['gestor-propria-versao'] = {
      explainsWhyBlocked: true,
      approveDisabled: false,
      approveShown: await card
        .getByRole('button', { name: /^Aprovar registro/ })
        .count(),
    };
    await expect(
      card.getByRole('button', { name: /^Aprovar registro/ }),
    ).toHaveCount(0);
  }

  // Admin: decide a prepared record; the value is already on the card.
  {
    await admin.reload();
    await open(admin, 'Economia');
    await admin.waitForLoadState('networkidle');
    const m = new Meter(),
      econ = econOf(admin);
    const card = econ
      .locator('article')
      .filter({ hasText: PENDING_RATE_SOURCE });
    await expect(card).toContainText('BRL 95,00');
    await expect(card).toContainText('Bia Dev');
    await shot(admin, 'after-admin-decidir-registro-1280');
    await m.fill(
      econ.getByLabel('Justificativa econômica de decisão/reversão'),
      'Conferido com a planilha',
    );
    await m.click(card.getByRole('button', { name: /^Aprovar registro/ }));
    await expect(card).toHaveCount(0);
    results['admin-decidir-registro'] = { clicks: m.clicks, fields: m.fields };
    expect(m.clicks).toBeLessThanOrEqual(1);
  }

  // Gestor: prepare an hourly cost, with the period of the approved premises.
  {
    await manager.reload();
    await open(manager, 'Economia');
    await manager.waitForLoadState('networkidle');
    const m = new Meter(),
      econ = econOf(manager);
    await m.click(econ.getByRole('tab', { name: 'Preparar' }));
    await shot(manager, 'after-gestor-preparar-escolha-1280');
    const form = econ.getByRole('form', {
      name: 'Preparar registro econômico',
    });
    await m.click(form.getByRole('radio', { name: /^Custo por hora/ }));
    await expect(form.getByLabel('Início da competência')).not.toHaveValue('');
    await m.fill(form.getByLabel('Fonte das premissas'), 'Planilha de custos');
    await m.select(
      form.getByRole('combobox', {
        name: 'Profissional econômico',
        exact: true,
      }),
      people.po, // Davi and Bia already have a rate for the inherited period.
    );
    await m.fill(form.getByLabel('Custo por hora (BRL)'), '125,00');
    await expect(form.getByText('= BRL 125,00')).toBeVisible();
    await shot(manager, 'after-gestor-preparar-custo-1280');
    await atMobile(manager, 'after-gestor-preparar-custo');
    await m.click(
      form.getByRole('button', { name: 'Preparar versão econômica' }),
    );
    await expect(econ.getByRole('status')).toContainText('Versão preparada');
    results['gestor-preparar-custo'] = { clicks: m.clicks, fields: m.fields };
    expect(m.clicks + m.fields).toBeLessThanOrEqual(7);
  }

  // A typed amount the screen cannot read exactly blocks the form; it is never guessed.
  {
    const form = econOf(manager).getByRole('form', {
      name: 'Preparar registro econômico',
    });
    const rate = form.getByLabel('Custo por hora (BRL)');
    await rate.fill('12.50');
    await expect(form.getByText('vírgula antes dos centavos')).toBeVisible();
    expect(await rate.evaluate((e: HTMLInputElement) => e.validity.valid)).toBe(
      false,
    );
    await rate.fill('');
    expect(await rate.evaluate((e: HTMLInputElement) => e.validity.valid)).toBe(
      false,
    );
    // The inherited period can already have a cost for this person: said here, in words.
    await form
      .getByRole('combobox', { name: 'Profissional econômico', exact: true })
      .selectOption(people.dev);
    await expect(form).toContainText('já tem custo nesta vigência');
    await form
      .getByRole('button', { name: 'Revisar a versão existente' })
      .click();
    await expect(form).toContainText('o original será preservado');
    await expect(form.getByLabel('Custo por hora (BRL)')).toHaveValue('120,00');
    await form.getByRole('button', { name: 'Preparar série nova' }).click();
  }

  // Gestor: reversing asks for its own reason, next to the entry being reversed.
  {
    const econ = econOf(manager);
    await econ.getByRole('tab', { name: 'Horas' }).click();
    const entry = econ
      .locator('article')
      .filter({ hasText: 'Trabalho sintético 360 min há 5 dias' });
    await expect(entry).toContainText('Aprovadas');
    await shot(manager, 'after-gestor-registro-horas-1280');
    await entry
      .getByRole('button', { name: /^Reverter horas de Davi Dev/ })
      .click();
    await entry.getByRole('button', { name: 'Confirmar reversão' }).click();
    await expect(entry.getByRole('alert')).toContainText('Escreva o motivo');
    await entry
      .getByLabel('Justificativa da reversão')
      .fill('Lançada em duplicidade');
    await entry.getByRole('button', { name: 'Confirmar reversão' }).click();
    await expect(econ.getByRole('status')).toContainText('revertidas');
    await expect(entry).toContainText('Revertidas');
    await expect(entry.getByRole('button', { name: /^Reverter/ })).toHaveCount(
      0,
    );
  }

  // Gestor: calculate and read a project's profitability.
  {
    const m = new Meter(),
      econ = econOf(manager);
    await m.click(econ.getByRole('tab', { name: 'Rentabilidade' }));
    await m.click(
      econ.getByRole('button', { name: /^Calcular e preservar Loja Aurora/ }),
    );
    const report = econ
      .getByRole('article', { name: /^Relatório econômico/ })
      .first();
    await expect(report).toContainText('Margem projetada');
    const top =
      (await report.boundingBox())!.y +
      (await manager.evaluate(() => window.scrollY));
    results['gestor-calcular-rentabilidade'] = {
      clicks: m.clicks,
      fields: m.fields,
      reportTopPx: Math.round(top),
    };
    await shot(manager, 'after-gestor-rentabilidade-1280');
    await atMobile(manager, 'after-gestor-rentabilidade');
    expect(m.clicks).toBeLessThanOrEqual(2);
    await noSeriousAxe(manager, 'rentabilidade');
  }

  // Developer: log hours; the form is the first thing on the screen.
  {
    const m = new Meter(),
      econ = econOf(dev);
    const form = econ.getByRole('form', { name: 'Apontar horas próprias' });
    const demand = form.getByRole('combobox', {
      name: 'Demanda das horas',
      exact: true,
    });
    await m.select(
      demand,
      (await demand.locator('option').nth(1).getAttribute('value'))!,
    );
    await m.fill(form.getByLabel('Duração (horas)'), '1,5');
    await expect(form.getByText('= 1h30 (90 min)')).toBeVisible();
    await m.fill(
      form.getByLabel('Comentário do apontamento'),
      'Ajuste de integração',
    );
    await shot(dev, 'after-desenvolvedor-apontar-1280');
    await atMobile(dev, 'after-desenvolvedor-apontar');
    await m.click(form.getByRole('button', { name: 'Registrar horas' }));
    await expect(econ.getByRole('status')).toContainText('Horas pendentes');
    await expect(
      econ
        .locator('article')
        .filter({ hasText: 'Ajuste de integração' })
        .first(),
    ).toContainText('1h30');
    results['desenvolvedor-apontar-horas'] = {
      clicks: m.clicks,
      fields: m.fields,
    };
    expect(m.clicks).toBeLessThanOrEqual(3);
  }

  // Gestor: decide a submitted scope, entering by the menu.
  {
    await manager.reload();
    await open(manager, 'Comercial');
    await manager.waitForLoadState('networkidle');
    const m = new Meter(),
      c = manager.getByRole('region', { name: 'Controle comercial' });
    results['tela-comercial-gestor'] = await screenFacts(manager);
    await shot(manager, 'after-comercial-gestor-1280');
    await noSeriousAxe(manager, 'comercial gestor');
    // A recommendation's link opens the scope it names, even before the data has arrived.
    const { scopes } = await api<{
      scopes: { id: string; state: string }[];
    }>(manager, 'commercial');
    const submitted = scopes.find((s) => s.state === 'submitted')!;
    await manager.goto(`/#/comercial?escopo=${submitted.id}`);
    await manager.reload();
    await expect(c.getByLabel('Detalhe do escopo')).toBeFocused();
    await manager.goto('/#/comercial');
    await manager.reload();
    await manager.waitForLoadState('networkidle');
    await m.click(
      c.getByRole('button', { name: /^Revisar e decidir/ }).first(),
    );
    const detail = c.getByLabel('Detalhe do escopo');
    await expect(detail).toBeFocused();
    await detail.getByRole('button', { name: 'Aprovar escopo' }).click();
    await expect(c.getByRole('alert')).toContainText('Escreva a justificativa');
    await m.fill(
      c.getByLabel('Justificativa da decisão'),
      'Escopo conferido com o cliente',
    );
    await shot(manager, 'after-comercial-decidir-1280');
    await atMobile(manager, 'after-comercial-decidir');
    await m.click(c.getByRole('button', { name: 'Aprovar escopo' }));
    await expect(c.getByRole('status')).toContainText('Decisão humana');
    results['gestor-decidir-escopo'] = { clicks: m.clicks, fields: m.fields };
    expect(m.clicks).toBeLessThanOrEqual(2);
  }

  // PO: link an uncovered demand; a single candidate item is already suggested.
  {
    await po.reload();
    await open(po, 'Comercial');
    await po.waitForLoadState('networkidle');
    const m = new Meter(),
      c = po.getByRole('region', { name: 'Controle comercial' });
    const target = await demandToCover(po);
    results['po-demanda-coberta'] = target.title;
    results['po-itens-disponiveis'] = target.itemCount;
    const row = c.locator('article').filter({ hasText: target.title });
    await shot(po, 'after-comercial-cobertura-1280');
    await atMobile(po, 'after-comercial-cobertura');
    await noSeriousAxe(po, 'comercial po');
    await m.click(
      row.getByRole('button', { name: `Vincular ${target.title}` }),
    );
    await expect(c.getByRole('status')).toContainText('coberta');
    await expect(row).toHaveCount(0);
    results['po-vincular-cobertura'] = { clicks: m.clicks, fields: m.fields };
    expect(m.clicks).toBeLessThanOrEqual(1);
  }

  // PO: estimate a demand; project, terms and owner come from it.
  {
    await po.reload();
    await open(po, 'Economia');
    await po.waitForLoadState('networkidle');
    const target = await demandToEstimate(po);
    results['po-demanda-estimada'] = target.title;
    const m = new Meter(),
      econ = econOf(po);
    const form = econ.getByRole('form', {
      name: 'Preparar registro econômico',
    });
    await m.select(
      form.getByRole('combobox', { name: 'Demanda a estimar', exact: true }),
      target.id,
    );
    if (target.owner)
      await expect(
        form.getByRole('combobox', {
          name: 'Profissional econômico',
          exact: true,
        }),
      ).toHaveValue(target.owner);
    await m.fill(
      form.getByLabel('Fonte das premissas'),
      'Reunião de refinamento',
    );
    await m.fill(form.getByLabel('Horas previstas'), '10');
    await m.fill(form.getByLabel('Horas para concluir'), '8');
    await m.fill(
      form.getByLabel('Data prevista de conclusão'),
      new Date(Date.now() + 864e6).toLocaleDateString('pt-BR', {
        timeZone: 'UTC',
      }),
    );
    await shot(po, 'after-po-estimativa-1280');
    await atMobile(po, 'after-po-estimativa');
    await m.click(
      form.getByRole('button', { name: 'Preparar versão econômica' }),
    );
    await expect(econ.getByRole('status')).toContainText('Versão preparada');
    results['po-estimar-demanda'] = { clicks: m.clicks, fields: m.fields };
    expect(m.clicks).toBeLessThanOrEqual(3);
  }

  // Tabs follow the ARIA pattern: one Tab stop, arrows move between them.
  {
    await admin.reload();
    await open(admin, 'Economia');
    const first = admin.getByRole('tab', { name: /^Para decidir/ });
    await first.focus();
    await admin.keyboard.press('ArrowRight');
    await expect(admin.getByRole('tab', { name: 'Preparar' })).toBeFocused();
    await expect(admin.getByRole('tab', { name: 'Preparar' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await admin.keyboard.press('End');
    await expect(admin.getByRole('tab', { name: 'Auditoria' })).toBeFocused();
    await admin.keyboard.press('ArrowRight');
    await expect(first).toBeFocused();
  }

  writeFileSync(
    `${EVIDENCE}/metrics-after.json`,
    JSON.stringify(results, null, 2) + '\n',
  );
  expect(errors).toEqual([]);
});
