import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

export type Module =
  | 'Mission Control'
  | 'Solicitações'
  | 'Clientes e projetos'
  | 'Comercial'
  | 'Economia'
  | 'Atendimento inteligente'
  | 'Acesso e usuários'
  | 'Auditoria'
  | 'Entrega agêntica';

/** Opens a module through the visible menu (sidebar, or the compact strip on narrow screens). */
export async function open(page: Page, module: Module) {
  // The menu appears once the session is known, so this also waits for it.
  await page
    .getByRole('navigation', { name: /^Módulos/ })
    .filter({ visible: true })
    .getByRole('link', { name: module, exact: true })
    .click();
  await expect(
    page.getByRole('heading', { level: 1, name: module, exact: true }),
  ).toBeVisible();
}
