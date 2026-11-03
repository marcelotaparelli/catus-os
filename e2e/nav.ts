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
  const sidebar = page.getByRole('navigation', {
    name: 'Módulos',
    exact: true,
  });
  const menu = (await sidebar.isVisible())
    ? sidebar
    : page.getByRole('navigation', { name: 'Módulos (compacto)' });
  await menu.getByRole('link', { name: module, exact: true }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: module, exact: true }),
  ).toBeVisible();
}
