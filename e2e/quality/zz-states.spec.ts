/**
 * Permissions, error/loading feedback and concurrent edits in M3. Runs last
 * because it changes seeded data (policy version).
 */
import { test, expect, visit } from './fixtures';
import type { Page } from '@playwright/test';

const m3 = (page: Page) =>
  page.getByRole('region', { name: 'Controle comercial' });

test('role matrix: controls offered match each role', async ({
  page,
  as,
  browser,
}) => {
  const expectations = {
    administrator: {
      policy: 1,
      contract: 1,
      prepare: 1,
      close: 1,
      coverage: 1,
    },
    manager: { policy: 0, contract: 1, prepare: 1, close: 1, coverage: 1 },
    po: { policy: 0, contract: 1, prepare: 1, close: 0, coverage: 1 },
    developer: { policy: 0, contract: 0, prepare: 0, close: 0, coverage: 0 },
  } as const;
  for (const [role, want] of Object.entries(expectations)) {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    const { login } = await import('../login');
    const { ROLES } = await import('./fixtures');
    await login(p, ROLES[role as keyof typeof ROLES]);
    await visit(p, 'Comercial');
    const r = m3(p);
    await expect(
      r.getByRole('heading', { name: 'Contrato Portal B2B 2026' }),
    ).toBeVisible();
    const got = {
      policy: await r
        .getByText('Configurar alçadas comerciais', { exact: true })
        .count(),
      contract: await r
        .getByText('Cadastrar contrato', { exact: true })
        .count(),
      prepare: await r
        .getByRole('button', { name: 'Preparar escopo inicial' })
        .count(),
      close: await r.getByRole('button', { name: 'Encerrar contrato' }).count(),
      coverage: await r
        .getByRole('form', { name: 'Revisar cobertura comercial' })
        .count(),
    };
    expect({ role, ...got }).toEqual({ role, ...want });
    await ctx.close();
  }
  void page;
  void as;
});

test('server refuses actions outside the role even when called directly', async ({
  page,
  as,
}) => {
  await as('developer');
  const status = await page.evaluate(async () => {
    const s = await (await fetch('/api/session')).json();
    const headers = {
      'X-CSRF-Token': s.csrfToken,
      'Content-Type': 'application/json',
      'Idempotency-Key': crypto.randomUUID(),
    };
    const policy = await fetch('/api/commercial/policy', {
      method: 'POST',
      headers,
      body: JSON.stringify({ version: 1, approval_roles: ['manager'] }),
    });
    const contract = await fetch('/api/contracts', {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ title: 'x' }),
    });
    return [policy.status, contract.status];
  });
  expect(status).toEqual([403, 403]);
});

test('loading, network failure and invalid responses give visible feedback', async ({
  page,
  as,
}) => {
  await as('po');
  await visit(page, 'Comercial');
  const refresh = m3(page).getByRole('button', { name: 'Atualizar comercial' });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route('**/api/commercial', async (route) => {
    await gate;
    await route.continue();
  });
  await refresh.click();
  await expect(refresh).toBeDisabled(); // busy state while the request is pending
  release();
  await expect(refresh).toBeEnabled();
  await page.unroute('**/api/commercial');

  await page.route('**/api/commercial', (route) =>
    route.abort('connectionrefused'),
  );
  await refresh.click();
  await expect(m3(page).getByRole('alert')).toBeVisible();
  await page.unroute('**/api/commercial');

  await page.route('**/api/commercial', (route) =>
    route.fulfill({
      status: 502,
      contentType: 'text/html',
      body: '<h1>Bad gateway</h1>',
    }),
  );
  await refresh.click();
  await expect(m3(page).getByRole('alert')).toBeVisible();
  await expect(m3(page).getByRole('alert')).not.toContainText('JSON');
  await page.unroute('**/api/commercial');

  await refresh.click();
  await expect(m3(page).getByRole('alert')).toHaveCount(0);
  await expect(
    m3(page).getByRole('heading', { name: 'Contrato Portal B2B 2026' }),
  ).toBeVisible();
});

test('concurrent policy edit: stale screen is refused with a clear message', async ({
  page,
  as,
  browser,
}) => {
  await as('administrator');
  const other = await (await browser.newContext()).newPage();
  const { login } = await import('../login');
  await login(other, 'admin@browser.test');
  for (const p of [page, other]) await visit(p, 'Comercial');
  for (const p of [page, other])
    await m3(p)
      .getByText('Configurar alçadas comerciais', { exact: true })
      .click();
  await m3(other).getByRole('button', { name: 'Salvar alçadas' }).click();
  await expect(m3(other).getByRole('status')).toContainText('registrada');
  await m3(page)
    .getByRole('checkbox', { name: 'Gestor pode decidir' })
    .uncheck();
  await m3(page).getByRole('button', { name: 'Salvar alçadas' }).click();
  await expect(m3(page).getByRole('alert')).toContainText('recarregue');
  // Saving with the keyboard after reloading works.
  const refresh = m3(page).getByRole('button', { name: 'Atualizar comercial' });
  await refresh.click();
  await expect(m3(page).getByRole('alert')).toHaveCount(0);
  await expect(refresh).toBeEnabled();
  await m3(page).getByRole('button', { name: 'Salvar alçadas' }).focus();
  await page.keyboard.press('Enter');
  await expect(m3(page).getByRole('status')).toContainText('registrada');
});
