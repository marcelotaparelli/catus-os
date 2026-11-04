/**
 * Module navigation: role-aware menu and routes, direct links (also across the
 * OIDC login), reload, back/forward, legacy anchors, unknown routes, on-demand
 * loading and context preserved between modules. The server stays the authority:
 * hidden routes are a convenience, so refusals are asserted on the API as well.
 */
import type { Page, Request } from '@playwright/test';
import { test, expect, visit, MODULES, ROLES } from './fixtures';
import type { QualityRole } from './fixtures';
import { login } from '../login';

const h1 = (page: Page, name: string) =>
  page.getByRole('heading', { level: 1, name, exact: true });
const menu = (page: Page) =>
  page.getByRole('navigation', { name: 'Módulos', exact: true });
const PATHS: Record<string, string> = {
  'Atendimento inteligente': 'atendimento-inteligente',
  'Acesso e usuários': 'acesso',
  Auditoria: 'auditoria',
};
const CHUNKS: Record<string, string> = {
  'Atendimento inteligente': 'IntelligentIntake',
  'Acesso e usuários': 'AccessAdmin',
  Auditoria: 'AuditLog',
};

test('menu and routes follow each role; restricted routes load nothing', async ({
  browser,
}) => {
  test.setTimeout(90000);
  for (const role of Object.keys(ROLES) as QualityRole[]) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const requests: string[] = [];
    page.on('request', (r: Request) => requests.push(r.url()));
    await login(page, ROLES[role]);
    await expect(menu(page).getByRole('link')).toHaveText(MODULES[role]);
    const restricted = Object.keys(PATHS).filter(
      (m) => !(MODULES[role] as string[]).includes(m),
    );
    for (const module of restricted) {
      await page.goto('/#/' + PATHS[module]);
      await expect(h1(page, 'Acesso restrito')).toBeVisible();
      await expect(page).toHaveTitle('Catus OS · Acesso restrito');
      expect(
        requests.filter((u) => u.includes(CHUNKS[module]!)),
        `${role} must not download the ${module} screen`,
      ).toEqual([]);
    }
    // The menu is a convenience; the API refuses on its own.
    const audit = await page.request.get('/api/audit');
    expect(audit.status()).toBe(
      ['administrator', 'manager'].includes(role) ? 200 : 403,
    );
    await ctx.close();
  }
});

test('direct links, reload, back/forward, legacy anchors and unknown routes', async ({
  page,
  as,
}) => {
  await as('po');
  await page.goto('/#/economia');
  await expect(h1(page, 'Economia')).toBeVisible();
  await expect(page).toHaveTitle('Catus OS · Economia');
  await expect(
    page.getByRole('region', { name: 'Inteligência econômica' }),
  ).toBeVisible();
  await page.reload();
  await expect(h1(page, 'Economia')).toBeVisible();
  await visit(page, 'Comercial');
  await visit(page, 'Solicitações');
  await page.goBack();
  await expect(h1(page, 'Comercial')).toBeVisible();
  await expect(page).toHaveURL(/#\/comercial$/);
  await page.goBack();
  await expect(h1(page, 'Economia')).toBeVisible();
  await page.goForward();
  await expect(h1(page, 'Comercial')).toBeVisible();
  await expect(
    menu(page).getByRole('link', { name: 'Comercial' }),
  ).toHaveAttribute('aria-current', 'page');

  // Anchors from the former single-page layout keep working.
  await page.goto('/#registro');
  await expect(page).toHaveURL(/#\/clientes$/);
  await expect(
    page.getByRole('heading', { name: 'Registrar contexto' }),
  ).toBeVisible();
  await page.goto('/#ia');
  await expect(h1(page, 'Atendimento inteligente')).toBeVisible();

  await page.goto('/#/nao-existe');
  await expect(h1(page, 'Página não encontrada')).toBeVisible();
  await page.getByRole('link', { name: 'Ir para o Mission Control' }).click();
  await expect(h1(page, 'Mission Control')).toBeVisible();
  await expect(page).toHaveURL(/#\/$/);
});

test('a direct link survives the corporate login', async ({ page }) => {
  await login(page, ROLES.po, '/#/comercial');
  await expect(h1(page, 'Comercial')).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Controle comercial' }),
  ).toBeVisible();
});

test('only Mission Control data loads at start; each module loads once, on first visit', async ({
  page,
}) => {
  const api: string[] = [];
  page.on('request', (r: Request) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/api/') && !u.pathname.startsWith('/api/auth/'))
      api.push(`${r.method()} ${u.pathname}`);
  });
  await login(page, ROLES.manager);
  await page.waitForLoadState('networkidle');
  expect([...new Set(api)].sort()).toEqual([
    'GET /api/members',
    'GET /api/mission-control',
    'GET /api/overview',
    'GET /api/session',
  ]);
  api.length = 0;
  await visit(page, 'Comercial');
  expect(api).toContain('GET /api/commercial');
  api.length = 0;
  await visit(page, 'Economia');
  expect(api).toContain('GET /api/economics');
  api.length = 0;
  await visit(page, 'Comercial');
  expect(api, 'returning to a module reuses it').toEqual([]);
});

test('drafts, selections and filters survive switching modules', async ({
  page,
  as,
}) => {
  await as('po');
  await visit(page, 'Comercial');
  const m3 = page.getByRole('region', { name: 'Controle comercial' });
  await m3.getByText('Cadastrar contrato', { exact: true }).click();
  await m3.getByLabel('Título do contrato').fill('Rascunho sintético');
  await visit(page, 'Solicitações');
  await page
    .getByRole('combobox', { name: 'Filtrar estado', exact: true })
    .selectOption('new');
  await expect(page).toHaveURL(/#\/solicitacoes\?estado=new$/);
  await visit(page, 'Comercial');
  await expect(m3.getByLabel('Título do contrato')).toHaveValue(
    'Rascunho sintético',
  );
  await visit(page, 'Solicitações');
  await expect(
    page.getByRole('combobox', { name: 'Filtrar estado', exact: true }),
  ).toHaveValue('new');
  await expect(page).toHaveURL(/#\/solicitacoes\?estado=new$/);
  // A filtered link from Mission Control applies exactly its own filter.
  await visit(page, 'Mission Control');
  await page.goto('/#/solicitacoes?responsavel=me');
  await expect(
    page.getByRole('combobox', { name: 'Filtrar estado', exact: true }),
  ).toHaveValue('');
  await expect(
    page.getByRole('combobox', { name: 'Filtrar responsável', exact: true }),
  ).toHaveValue('me');
});

test('signing out unmounts module screens before the next session', async ({
  page,
  as,
}) => {
  await as('administrator');
  await visit(page, 'Comercial');
  await expect(
    page.getByText('Configurar alçadas comerciais', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Sair', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Controle comercial' }),
  ).toHaveCount(0);
  await login(page, ROLES.developer, '/#/comercial');
  await expect(
    page.getByRole('region', { name: 'Controle comercial' }),
  ).toBeVisible();
  await expect(
    page.getByText('Configurar alçadas comerciais', { exact: true }),
  ).toHaveCount(0);
});
