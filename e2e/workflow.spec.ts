import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { codeFor } from '../tests/support/oidc-provider';
async function login(page: Page, email: string) {
  // Simulate only the IdP authorization screen. Execute the real login endpoint,
  // preserve its state cookie, then return a code to the real callback without DNS/network to .test.
  await page.route('**/api/auth/login', async (route) => {
    const start = await route.fetch({ maxRedirects: 0 });
    expect(start.status()).toBe(303);
    const auth = new URL(start.headers().location!);
    await route.fulfill({
      response: start,
      headers: {
        ...start.headers(),
        location: `http://127.0.0.1:5173/api/auth/callback?state=${auth.searchParams.get('state')}&code=${codeFor(auth, email)}`,
      },
    });
  });
  await page.goto('/');
  await page
    .getByRole('link', { name: 'Entrar com conta corporativa' })
    .click();
  await expect(page).toHaveURL('http://127.0.0.1:5173/');
  await expect(page.getByText(email, { exact: false }).first()).toBeVisible();
}
test('PO completes M0, developer executes assigned work, session survives reload, logout revokes access', async ({
  page,
  browser,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await login(page, 'po@browser.test');
  await expect(
    page.getByRole('heading', { name: 'Registrar contexto' }),
  ).toBeVisible();
  await page.getByLabel('Nome do cliente', { exact: true }).fill('E2E Cliente');
  await page.getByRole('button', { name: 'Cadastrar cliente' }).click();
  await page
    .getByRole('combobox', { name: 'Cliente', exact: true })
    .selectOption({ label: 'E2E Cliente' });
  await page.getByLabel('Nome do projeto').fill('E2E Loja');
  await page
    .getByRole('button', { name: 'Criar projeto', exact: true })
    .click();
  await page
    .getByRole('combobox', { name: 'Projeto', exact: true })
    .selectOption({ label: 'E2E Cliente / E2E Loja' });
  await page.getByLabel('Resumo e contexto').fill('Melhorar checkout');
  await page
    .getByRole('button', { name: 'Registrar atendimento', exact: true })
    .click();
  await page
    .getByRole('combobox', { name: 'Atendimento de origem', exact: true })
    .selectOption({ label: 'E2E Loja · Melhorar checkout' });
  await page.getByLabel('Título', { exact: true }).fill('Revisar checkout');
  await page
    .getByLabel('Descrição', { exact: true })
    .fill('Investigar abandono');
  await page
    .getByRole('combobox', { name: 'Responsável', exact: true })
    .selectOption({ label: 'Dev Browser · dev@browser.test' });
  await page
    .getByLabel('Próxima ação', { exact: true })
    .fill('Confirmar requisitos');
  await page
    .getByRole('button', { name: 'Criar solicitação', exact: true })
    .click();
  const card = page.locator('article').filter({
    has: page.getByRole('heading', { name: 'Revisar checkout', exact: true }),
  });
  await expect(card).toContainText('Nova');
  await expect(card).toContainText('Dev Browser');
  await expect(card).toContainText('Confirmar requisitos');
  for (const state of ['triage', 'ready']) {
    await card.getByRole('button', { name: 'Atualizar solicitação' }).click();
    const edit = page.getByRole('region', { name: 'Editar solicitação' });
    await edit
      .getByRole('combobox', { name: 'Estado', exact: true })
      .selectOption(state);
    await edit.getByRole('button', { name: 'Salvar atualização' }).click();
    await expect(edit).toHaveCount(0);
  }
  await page.reload();
  await expect(card).toContainText('Pronta');
  await expect(
    page.getByText('po@browser.test', { exact: false }).first(),
  ).toBeVisible();
  const context = await browser.newContext();
  const dev = await context.newPage();
  dev.on('pageerror', (e) => errors.push(e.message));
  try {
    await login(dev, 'dev@browser.test');
    await expect(
      dev.getByRole('heading', { name: 'Registrar contexto' }),
    ).toHaveCount(0);
    const devCard = dev.locator('article').filter({
      has: dev.getByRole('heading', {
        name: 'Revisar checkout',
        exact: true,
      }),
    });
    await devCard
      .getByRole('button', { name: 'Atualizar solicitação' })
      .click();
    const edit = dev.getByRole('region', { name: 'Editar solicitação' });
    await expect(
      edit.getByRole('combobox', { name: 'Responsável', exact: true }),
    ).toBeDisabled();
    await edit
      .getByRole('combobox', { name: 'Estado', exact: true })
      .selectOption('in_progress');
    await edit.getByLabel('Próxima ação').fill('Implementar teste');
    await edit.getByRole('button', { name: 'Salvar atualização' }).click();
    await expect(devCard).toContainText('Em execução');
    await expect(devCard).toContainText('Implementar teste');
    const session = await (await dev.request.get('/api/session')).json();
    const denied = await dev.request.post('/api/clients', {
      headers: {
        Origin: 'http://127.0.0.1:5173',
        'X-CSRF-Token': session.csrfToken,
      },
      data: { name: 'Not allowed' },
    });
    expect(denied.status()).toBe(403);
    await dev.screenshot({
      path: 'test-results/mission-control-m1.png',
      fullPage: true,
    });
    await dev.setViewportSize({ width: 390, height: 844 });
    expect(
      await dev.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await dev.getByRole('button', { name: 'Sair', exact: true }).click();
    await expect(
      dev.getByRole('link', { name: 'Entrar com conta corporativa' }),
    ).toBeVisible();
    expect((await dev.request.get('/api/mission-control')).status()).toBe(401);
  } finally {
    await context.close();
  }
  const outsider = await browser.newContext();
  const other = await outsider.newPage();
  try {
    await login(other, 'outsider@browser.test');
    await expect(
      other.getByRole('heading', { name: 'Revisar checkout', exact: true }),
    ).toHaveCount(0);
    await expect(
      other.getByText('Browser Other', { exact: false }).first(),
    ).toBeVisible();
  } finally {
    await outsider.close();
  }
  expect(errors).toEqual([]);
});
