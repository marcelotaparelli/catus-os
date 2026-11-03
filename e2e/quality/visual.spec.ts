/**
 * Visual regression against approved baselines in __screenshots__/ (rendered
 * by the pinned Playwright container, see docs/QUALITY.md). Timestamps are
 * masked; data comes from seed.setup.ts. Never update baselines to make CI pass:
 * regenerate them deliberately and review the diff in the PR.
 */
import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

const m3 = (page: Page) =>
  page.getByRole('region', { name: 'Controle comercial' });
const mask = (page: Page) => ({ mask: [page.locator('time')] });

async function selectApprovedScope(page: Page) {
  const select = m3(page).getByRole('combobox', {
    name: 'Versão de escopo',
    exact: true,
  });
  const option = select
    .locator('option')
    .filter({ hasText: 'Portal B2B · V1 ·' });
  await select.selectOption((await option.getAttribute('value'))!);
  await expect(m3(page).getByLabel('Detalhe do escopo')).toBeVisible();
}

test('login screen', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await expect(
    page.getByRole('link', { name: 'Entrar com conta corporativa' }),
  ).toBeVisible();
  await expect(page).toHaveScreenshot('login-1280.png');
});

test('Mission Control overview (administrator, 1280)', async ({ page, as }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await as('administrator');
  await expect(page).toHaveScreenshot(
    'mission-control-admin-1280.png',
    mask(page),
  );
});

test('M3 administrator with commercial authority form (1440)', async ({
  page,
  as,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await as('administrator');
  await m3(page)
    .getByText('Configurar alçadas comerciais', { exact: true })
    .click();
  await selectApprovedScope(page);
  await expect(m3(page)).toHaveScreenshot('m3-admin-1440.png', mask(page));
});

test('M3 PO contract form and approved scope (1280)', async ({ page, as }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await as('po');
  await m3(page).getByText('Cadastrar contrato', { exact: true }).click();
  await selectApprovedScope(page);
  await expect(m3(page)).toHaveScreenshot('m3-po-1280.png', mask(page));
});

test('M3 PO on mobile (390)', async ({ page, as }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await as('po');
  await m3(page).getByText('Cadastrar contrato', { exact: true }).click();
  await expect(m3(page)).toHaveScreenshot('m3-po-390.png', mask(page));
});

test('M3 developer read-only view (768)', async ({ page, as }) => {
  await page.setViewportSize({ width: 768, height: 900 });
  await as('developer');
  await selectApprovedScope(page);
  await expect(m3(page)).toHaveScreenshot('m3-developer-768.png', mask(page));
});
