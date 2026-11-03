import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { login } from './login';
import { open } from './nav';
import {
  buildEcommerceScenario,
  NAMES,
} from '../tests/support/ecommerce-scenario';
import type { Actor } from '../tests/support/ecommerce-scenario';

// Value-first acceptance. Runs in its own synthetic tenant of the disposable harness DB:
// builds the agency through the public API, then checks that the screens show the
// hand-worked figures and that a manager can answer the five questions at first sight.
const EVIDENCE = 'test-results/value-first';
const EMAILS: Record<Actor, string> = {
  admin: 'demo.admin@browser.test',
  manager: 'demo.gestor@browser.test',
  po: 'demo.po@browser.test',
  dev: 'demo.dev@browser.test',
  dev2: 'demo.dev2@browser.test',
};
async function session(browser: Browser, email: string) {
  const page = await (await browser.newContext()).newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page, email);
  return page;
}
async function request<T>(
  page: Page,
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  return page.evaluate(
    async ({ path, method, body }) => {
      const s = await (await fetch('/api/session')).json();
      const r = await fetch('/api/' + path, {
        method,
        headers: {
          'X-CSRF-Token': s.csrfToken,
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok)
        throw new Error(
          `${method} ${path}: ${r.status} ${JSON.stringify(json)}`,
        );
      return json;
    },
    { path, method, body },
  );
}
const shot = (page: Page, name: string, fullPage = true) =>
  page.screenshot({ path: `${EVIDENCE}/${name}.png`, fullPage });
async function noSeriousAxe(page: Page, label: string) {
  await page.evaluate(() =>
    document.querySelectorAll('details').forEach((d) => (d.open = true)),
  );
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(
    violations
      .filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))
      .map((v) => `${label}: ${v.id}`),
  ).toEqual([]);
}
async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
}

/** Recommendation → the right demand, surviving reload, for both demands and for edge cases. */
async function demandDeepLink(
  po: Page,
  requests: { dIndica: string; eLanding: string; aPix: string },
) {
  const m3 = po.getByRole('region', { name: 'Controle comercial' });
  const coverage = m3.getByRole('combobox', { name: 'Demanda para cobertura' });
  const card = (id: string) => po.locator(`[id="link-${id}"]`);
  const expectTarget = async (id: string, other: string) => {
    await expect(card(id)).toBeFocused();
    await expect(card(id)).toBeInViewport();
    await expect(card(id)).toHaveAttribute('aria-current', 'true');
    await expect(card(other)).not.toHaveAttribute('aria-current', 'true');
    await expect(coverage).toHaveValue(id);
  };
  // From the recommendation, through the menu state a person actually has.
  for (const [title, id, other] of [
    ['Programa de indicação', requests.dIndica, requests.eLanding],
    ['Landing da campanha', requests.eLanding, requests.dIndica],
  ] as const) {
    await open(po, 'Mission Control');
    await po
      .getByRole('region', { name: 'Operação do PO' })
      .getByRole('link', { name: `Abrir: Vincular “${title}”` })
      .click();
    await expect(po).toHaveURL(new RegExp(`#/comercial\\?demanda=${id}$`));
    await expectTarget(id, other);
    await po.reload();
    await expect(po).toHaveURL(new RegExp(`#/comercial\\?demanda=${id}$`));
    await expectTarget(id, other);
  }
  await po.screenshot({ path: `${EVIDENCE}/11-po-deep-link-demanda.png` });
  // Covered demand has no card: the coverage form is what opens, with it selected.
  await po.goto(`/#/comercial?demanda=${requests.aPix}`);
  await po.reload();
  await expect(coverage).toHaveValue(requests.aPix);
  await expect(coverage).toBeFocused();
  await expect(coverage).toBeInViewport();
  // An id that is not here never selects anything else.
  await po.goto(`/#/comercial?demanda=${crypto.randomUUID()}`);
  await po.reload();
  await expect(m3.getByRole('alert')).toContainText('não foi encontrada');
  await expect(coverage).toHaveValue('');
  await expect(po.locator('.queue-card.targeted')).toHaveCount(0);
}
/** DD/MM/AAAA on screen and in fields; the API still receives ISO. */
async function brazilianDates(po: Page) {
  await po.goto('/#/comercial');
  await po.reload();
  const m3 = po.getByRole('region', { name: 'Controle comercial' });
  await m3.getByText('Cadastrar contrato', { exact: true }).click();
  const from = m3.getByLabel('Vigência inicial (UTC)'),
    until = m3.getByLabel('Vigência final (UTC)');
  await m3
    .getByRole('combobox', { name: 'Projeto contratual' })
    .selectOption({ label: NAMES.e });
  await m3.getByLabel('Título do contrato').fill('Contrato de datas');
  await m3.getByLabel('Referência documental').fill('SINTETICO-DATAS');
  // Impossible and US-order days are refused on the spot and nothing is sent.
  let posted: Record<string, string> | undefined;
  po.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/api/contracts'))
      posted = r.postDataJSON();
  });
  await from.fill('31/02/2026');
  await until.fill('13/25/2026');
  await m3
    .getByRole('button', { name: 'Registrar contrato', exact: true })
    .click();
  await expect(m3).toContainText('Use uma data válida em DD/MM/AAAA.');
  expect(posted).toBeUndefined();
  // 02/03 must mean 2 March: the ambiguous case this field exists to settle.
  await from.fill('02/03/2026');
  await until.fill('01/03/2026');
  await expect(m3).toContainText('Não pode ser antes de 02/03/2026.');
  await until.fill('31122026');
  await m3
    .getByRole('button', { name: 'Registrar contrato', exact: true })
    .click();
  await expect
    .poll(() => posted)
    .toMatchObject({ valid_from: '2026-03-02', valid_until: '2026-12-31' });
  const contract = m3
    .locator('article')
    .filter({ has: po.getByRole('heading', { name: 'Contrato de datas' }) });
  await expect(contract).toContainText('Vigência 02/03/2026 a 31/12/2026');
  await shot(po, '12-po-datas-brasileiras');
  // Same value back from the persisted record, and no native date field left anywhere.
  const saved = await request<{ contracts: Record<string, string>[] }>(
    po,
    'commercial',
  );
  const row = saved.contracts.find((c) => c.title === 'Contrato de datas')!;
  expect(row.valid_from!.slice(0, 10)).toBe('2026-03-02');
  expect(row.valid_until!.slice(0, 10)).toBe('2026-12-31');
  for (const module of [
    'Mission Control',
    'Comercial',
    'Economia',
    'Clientes e projetos',
  ] as const) {
    await open(po, module);
    await po.evaluate(() =>
      document.querySelectorAll('details').forEach((d) => (d.open = true)),
    );
    await expect(
      po.locator('main input[type="date"], main input[type="datetime-local"]'),
    ).toHaveCount(0);
    const text = await po.locator('main').evaluate((m) => {
      const copy = m.cloneNode(true) as HTMLElement;
      copy.querySelectorAll('pre').forEach((p) => p.remove());
      return copy.innerText;
    });
    expect(text.match(/\b\d{4}-\d{2}-\d{2}\b/g), module).toBeNull();
  }
}

test('value first: synthetic agency → role readings with verified figures → action reached in one click', async ({
  browser,
}) => {
  test.setTimeout(240000);
  mkdirSync(EVIDENCE, { recursive: true });
  const errors: string[] = [];
  const pages = {} as Record<Actor, Page>;
  for (const who of Object.keys(EMAILS) as Actor[]) {
    pages[who] = await session(browser, EMAILS[who]);
    pages[who].on('pageerror', (e) => errors.push(e.message));
  }
  const members = await request<{ id: string; email: string }[]>(
    pages.admin,
    'members',
  );
  const people = Object.fromEntries(
    (Object.keys(EMAILS) as Actor[]).map((who) => [
      who,
      members.find((m) => m.email === EMAILS[who])!.id,
    ]),
  ) as Record<Actor, string>;
  const scenario = await buildEcommerceScenario(
    (who, path, method = 'GET', body) =>
      request(pages[who], path, method, body),
    people,
  );

  // Gestor: one screen, no expanding, answers the five questions.
  const manager = pages.manager;
  await manager.reload();
  const exec = manager.getByRole('region', { name: 'Visão executiva' });
  await expect(exec.getByRole('heading', { level: 2 })).toHaveText(
    '4 de 5 projetos precisam de atenção',
  );
  const started = Date.now();
  // 1. Which projects need attention, most urgent first.
  const names = exec.getByRole('article');
  await expect(names).toHaveCount(5);
  await expect(names.nth(0)).toContainText(NAMES.b);
  await expect(names.nth(0)).toContainText('Margem negativa');
  await expect(names.nth(1)).toContainText(NAMES.a);
  await expect(names.nth(1)).toContainText('Em risco');
  await expect(names.nth(2)).toContainText(NAMES.d);
  await expect(names.nth(2)).toContainText('Dados insuficientes');
  await expect(names.nth(3)).toContainText(NAMES.e);
  await expect(names.nth(3)).toContainText('Sem base econômica');
  await expect(names.nth(4)).toContainText(NAMES.c);
  await expect(names.nth(4)).toContainText('Margem positiva');
  // 2 and 3. Where hours overrun and the economic impact, hand-worked in docs/VALUE_FIRST.md.
  const a = exec.getByRole('article', { name: `Projeto ${NAMES.a}` });
  for (const v of ['40h', '28h', '24h', '+12h'])
    await expect(a.locator('.metrics')).toContainText(v);
  for (const v of [
    'BRL 8.700,00',
    'BRL 5.110,00',
    'BRL 10.590,00',
    '+BRL 1.890,00',
    'BRL 15.000,00',
    'BRL 4.410,00',
    '29,40%',
    'BRL 2.990,00',
    '33,22%',
  ])
    await expect(a.locator('.metrics')).toContainText(v);
  const b = exec.getByRole('article', { name: `Projeto ${NAMES.b}` });
  for (const v of ['BRL -360,00', '-6,00%', 'BRL 6.360,00', '+18h'])
    await expect(b.locator('.metrics')).toContainText(v);
  const c = exec.getByRole('article', { name: `Projeto ${NAMES.c}` });
  for (const v of ['BRL 10.500,00', '52,50%'])
    await expect(c.locator('.metrics')).toContainText(v);
  // Absent stays absent: never a zero margin.
  const d = exec.getByRole('article', { name: `Projeto ${NAMES.d}` });
  const margin = d.locator('.metrics > div').filter({ hasText: 'Margem' });
  await expect(margin).toContainText('Indisponível');
  await expect(margin).not.toContainText('BRL 0,00');
  await expect(d).toContainText('ainda não entram em custo');
  await expect(d).toContainText('Capacidade alocada declarada');
  // 4 and 5. What to do now and who owns it, with the reason.
  const now = exec.getByRole('list', { name: 'O que fazer agora' });
  await expect(now.getByRole('listitem').first()).toContainText(
    'Decidir entre aditivo comercial e redução de escopo',
  );
  await expect(now.getByRole('listitem').first()).toContainText(
    'Alice Admin ou Marina Gestora',
  );
  await expect(now.getByRole('listitem').first()).toContainText('Por quê');
  await expect(now).toContainText('Reavaliar “Checkout com Pix”');
  await expect(now).toContainText('Davi Dev');
  expect(Date.now() - started).toBeLessThan(60000);
  await shot(manager, '01-gestor-visao-executiva');
  await manager.screenshot({
    path: `${EVIDENCE}/00-gestor-primeira-dobra.png`,
  });

  // Traceability: where the hours go and where the numbers come from.
  await a.getByText('Onde as horas estão sendo consumidas').click();
  await expect(a.getByRole('table')).toContainText('+15h');
  await a.getByText('De onde vêm estes números').click();
  await expect(a).toContainText('motor m4.1');
  await shot(manager, '02-gestor-rastreabilidade');

  // One click from the recommendation to the right panel, then the reading updates.
  await now
    .getByRole('listitem')
    .filter({ hasText: NAMES.d })
    .getByRole('link', { name: 'Abrir' })
    .click();
  const econ = manager.getByRole('region', { name: 'Inteligência econômica' });
  const pending = econ
    .locator('article')
    .filter({ hasText: 'Trabalho sintético 360 min há 5 dias' });
  await expect(pending).toBeVisible();
  await expect(econ.getByRole('note')).toContainText('Próximo passo');
  await shot(manager, '03-gestor-decisao-horas');
  await econ
    .getByLabel('Justificativa econômica de decisão/reversão')
    .fill('Horas conferidas');
  await pending.getByRole('button', { name: /^Aprovar horas/ }).click();
  await expect(econ.getByRole('status')).toContainText('decisão registrada');
  await expect(pending).toHaveCount(0);
  await open(manager, 'Mission Control');
  await expect(d.locator('.metrics')).toContainText('6h');
  await expect(d).not.toContainText('Decisão de horas pendentes');

  // Deep link opens the capacity form with the project already chosen.
  await d.getByText(/^Próximas ações/).click();
  await d
    .getByRole('listitem')
    .filter({ hasText: 'capacidade alocada declarada' })
    .getByRole('link', { name: 'Abrir' })
    .click();
  const form = econ.getByRole('form', { name: 'Preparar registro econômico' });
  await expect(form).toBeVisible();
  await expect(
    form.getByRole('radio', { name: /^Capacidade alocada/ }),
  ).toBeChecked();
  await expect(
    form.getByRole('combobox', { name: 'Projeto econômico' }),
  ).not.toHaveValue('');
  await expect(
    form.getByLabel('Início da competência/vigência'),
  ).not.toHaveValue('');
  await shot(manager, '04-gestor-formulario-preenchido');

  // PO: demands, deadlines, blocks and scopes; no money anywhere on the page.
  const po = pages.po;
  await po.reload();
  const opsPo = po.getByRole('region', { name: 'Operação do PO' });
  await expect(opsPo).toContainText('Notificações push');
  await expect(opsPo).toContainText('Bloqueada');
  await expect(opsPo).toContainText('vencido');
  await expect(opsPo).toContainText('Submetido');
  await expect(po.locator('main')).not.toContainText('BRL');
  await shot(po, '05-po-operacao');
  await noSeriousAxe(po, 'po');
  await po.reload();
  await demandDeepLink(po, scenario.requests);
  await brazilianDates(po);
  await open(po, 'Mission Control');

  // Developer: own work, next action, own hours; one click to log with fields filled.
  const dev = pages.dev;
  await dev.reload();
  const hours = dev.getByRole('region', { name: 'Meus apontamentos' });
  await expect(hours).toContainText('Aprovadas');
  await expect(hours.getByRole('heading', { level: 2 })).toContainText(
    'demandas suas em aberto',
  );
  await expect(dev.locator('main')).not.toContainText('BRL');
  await shot(dev, '06-desenvolvedor-meu-trabalho');
  await noSeriousAxe(dev, 'developer');
  await dev.reload();
  await dev
    .getByRole('region', { name: 'Minhas prioridades' })
    .getByRole('link', { name: 'Apontar horas nesta demanda' })
    .first()
    .click();
  const log = dev.getByRole('form', { name: 'Apontar horas próprias' });
  await expect(log).toBeVisible();
  await expect(
    log.getByRole('combobox', { name: 'Demanda das horas' }),
  ).not.toHaveValue('');
  await shot(dev, '07-desenvolvedor-apontamento-preenchido');

  // Administrator: governance first, rentability one click away.
  const admin = pages.admin;
  await admin.reload();
  const gov = admin.getByRole('region', { name: 'Governança' });
  await expect(gov).toContainText('Alçada comercial');
  await expect(gov).toContainText('Aprovação independente');
  await expect(gov).toContainText('Em dia');
  await shot(admin, '08-administrador-governanca');
  await noSeriousAxe(admin, 'administrator');

  // Gestor: accessibility with every detail open, and a usable phone layout.
  await manager.goto('/#/');
  await manager.reload();
  await expect(exec).toBeVisible();
  await noSeriousAxe(manager, 'manager');
  await manager.setViewportSize({ width: 390, height: 844 });
  await manager.reload();
  await expect(exec).toBeVisible();
  await noOverflow(manager);
  await manager.screenshot({ path: `${EVIDENCE}/09-gestor-celular.png` });
  await manager.getByRole('list', { name: 'O que fazer agora' }).waitFor();
  await shot(manager, '10-gestor-celular-pagina');
  expect(errors).toEqual([]);
});
