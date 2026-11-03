/**
 * Shared fixtures for the quality suite (visual, accessibility, responsive, keyboard).
 * Every test fails on uncaught page errors or console errors that are not
 * expected HTTP refusals, so silent JavaScript regressions cannot pass.
 */
import { test as base, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { login } from '../login';
import { open } from '../nav';
import type { Module } from '../nav';

export const ROLES = {
  administrator: 'admin@browser.test',
  manager: 'manager@browser.test',
  po: 'po@browser.test',
  developer: 'dev@browser.test',
} as const;
export type QualityRole = keyof typeof ROLES;

export const test = base.extend<{
  jsErrors: string[];
  as: (role: QualityRole) => Promise<Page>;
}>({
  jsErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
      page.on('console', (m) => {
        // Browsers log refused fetches (401/403/409/503) as console errors;
        // those are asserted explicitly by the tests that cause them.
        if (
          m.type() === 'error' &&
          !m.text().startsWith('Failed to load resource')
        )
          errors.push(`console: ${m.text()}`);
      });
      await use(errors);
      expect(errors, 'unexpected JavaScript errors').toEqual([]);
    },
    { auto: true },
  ],
  as: async ({ page }, use) => {
    await use(async (role) => {
      await login(page, ROLES[role]);
      await expect(
        page.getByRole('region', { name: 'Resumo operacional' }),
      ).toBeVisible();
      // Wait for every module request to settle, then for fonts.
      await page.waitForLoadState('networkidle');
      await page.evaluate(() => document.fonts.ready);
      return page;
    });
  },
});
export { expect };

/** Opens a module and waits until its data requests settle. */
export async function visit(page: Page, module: Module) {
  await open(page, module);
  await page.waitForLoadState('networkidle');
  await expect(
    page.getByRole('status').filter({ hasText: 'Carregando módulo' }),
  ).toHaveCount(0);
}

/** Modules each role sees in the menu (mirrors src/web/routes.ts on purpose). */
export const MODULES: Record<QualityRole, Module[]> = {
  administrator: [
    'Mission Control',
    'Solicitações',
    'Clientes e projetos',
    'Comercial',
    'Economia',
    'Atendimento inteligente',
    'Acesso e usuários',
    'Auditoria',
    'Entrega agêntica',
  ],
  manager: [
    'Mission Control',
    'Solicitações',
    'Clientes e projetos',
    'Comercial',
    'Economia',
    'Atendimento inteligente',
    'Auditoria',
    'Entrega agêntica',
  ],
  po: [
    'Mission Control',
    'Solicitações',
    'Clientes e projetos',
    'Comercial',
    'Economia',
    'Atendimento inteligente',
    'Entrega agêntica',
  ],
  developer: [
    'Mission Control',
    'Solicitações',
    'Clientes e projetos',
    'Comercial',
    'Economia',
    'Entrega agêntica',
  ],
};

/** Opens every <details> on the page so scans and layout checks cover hidden forms. */
export async function expandAll(page: Page) {
  await page.evaluate(() =>
    document.querySelectorAll('details').forEach((d) => (d.open = true)),
  );
}
