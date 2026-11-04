import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { open } from '../nav';

/** The one place to register a demand: the action queue in Solicitações. */
export async function registerDemand(
  page: Page,
  d: {
    origin: string;
    title: string;
    description: string;
    action: string;
    owner?: string;
  },
) {
  await open(page, 'Solicitações');
  const queue = page.getByRole('region', { name: 'Fila de ações' });
  await queue.getByRole('button', { name: 'Registrar demanda' }).click();
  const form = queue.getByRole('form', { name: 'Registrar demanda' });
  const origin = form.getByRole('combobox', { name: 'Atendimento de origem' });
  await origin.selectOption(
    (await origin
      .locator('option')
      .filter({ hasText: d.origin })
      .first()
      .getAttribute('value'))!,
  );
  await form.getByLabel('Título').fill(d.title);
  await form.getByLabel('Detalhes').fill(d.description);
  await form
    .getByRole('combobox', { name: 'Responsável' })
    .selectOption({ label: d.owner ?? 'Dev Browser · dev@browser.test' });
  await form.getByLabel('Próxima ação').fill(d.action);
  await form.getByRole('button', { name: 'Criar demanda' }).click();
  await expect(page.getByRole('status')).toContainText(
    `Demanda registrada: ${d.title}`,
  );
}
