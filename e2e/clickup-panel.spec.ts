import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { login } from './login';

// Own synthetic tenant, the only one of the harness with the integration on. The data went
// through the real sync with a stubbed provider (tests/support/clickup-seed.ts).
const EVIDENCE = 'test-results/clickup';
const panel = (page: import('@playwright/test').Page, project: string) =>
  page
    .getByRole('article', { name: 'Projeto ' + project })
    .getByRole('region', { name: 'Execução no ClickUp' });

test('partners see real figures, and old or absent data says so instead of showing zero', async ({
  page,
}) => {
  mkdirSync(EVIDENCE, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page, 'cu.gestor@browser.test');

  const fresh = panel(page, 'CU Atualizado');
  await expect(fresh.getByRole('heading')).toHaveText(
    'Execução no ClickUp: Com atrasos',
  );
  await expect(fresh).toContainText('Última sincronização');
  const figure = (name: string, within = fresh) =>
    within
      .locator('.kv')
      .filter({ has: page.getByText(name, { exact: true }) })
      .locator('dd');
  await expect(figure('Tarefas abertas')).toHaveText('3');
  await expect(figure('Tarefas concluídas')).toHaveText('1');
  await expect(figure('Subtarefas abertas')).toHaveText('1');
  await expect(figure('Atrasadas, com subtarefas')).toHaveText('1');
  await expect(figure('Abertas sem responsável')).toHaveText('1');
  // No status mapped yet: not knowable, so not zero.
  await expect(figure('Bloqueadas')).toHaveText('Não disponível');
  await expect(fresh).not.toContainText('%');

  await fresh.getByText('Responsáveis (2)').click();
  await expect(fresh).toContainText('Pessoa Um: 2 aberta(s), 1 atrasada(s)');
  await fresh.getByText('Atrasos e bloqueios (1)').click();
  const late = fresh.getByRole('link', { name: 'Tarefa sintética atrasada' });
  await expect(late).toHaveAttribute('href', 'https://app.clickup.com/t/a1');

  const failed = panel(page, 'CU Falhou');
  await expect(failed).toContainText('Dados desatualizados');
  await expect(failed).toContainText('o ClickUp respondeu com erro');
  await expect(figure('Tarefas abertas', failed)).toHaveText('2');

  const never = panel(page, 'CU Nunca lido');
  await expect(never.getByRole('heading')).toHaveText(
    'Execução no ClickUp: Não disponível',
  );
  await expect(never).toContainText('nenhuma leitura concluída');
  await expect(never.locator('.kv')).toHaveCount(0);

  await expect(panel(page, 'CU Antigo')).toContainText('Dados desatualizados');
  await expect(panel(page, 'CU Sem vínculo').locator('.kv')).toHaveCount(0);

  await fresh.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${EVIDENCE}/panel-1280.png`, fullPage: true });

  // Explicit mapping turns "not available" into a count, on the same screen. It is
  // saved for the list where the status appears: another list may mean something else.
  await fresh.getByText('Status sem significado definido (2)').click();
  await fresh
    .getByLabel('“Travado por Terceiro” em Lista sintética 9001 (1 tarefa(s))')
    .selectOption('blocked');
  await fresh
    .locator('form', { hasText: 'Travado por Terceiro' })
    .getByRole('button', { name: 'Salvar' })
    .click();
  await expect(fresh.getByRole('heading')).toHaveText(
    'Execução no ClickUp: Com bloqueios',
  );
  await expect(figure('Bloqueadas')).toHaveText('1');

  // Linking a list starts as unknown, and an invalid id is refused in place.
  const empty = panel(page, 'CU Sem vínculo');
  await empty.getByText('Listas vinculadas (0)').click();
  await empty.getByLabel('ID da lista do ClickUp').fill('não é número');
  await empty.getByRole('button', { name: 'Vincular' }).click();
  await expect(empty.getByRole('alert')).toContainText('ID numérico');
  await empty.getByLabel('ID da lista do ClickUp').fill('9100');
  await empty.getByRole('button', { name: 'Vincular' }).click();
  await expect(empty).toContainText('nenhuma leitura concluída');
  await expect(empty.locator('.kv')).toHaveCount(0);

  const axe = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(axe.violations.map((v) => v.id)).toEqual([]);

  await page.setViewportSize({ width: 390, height: 844 });
  await fresh.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${EVIDENCE}/panel-390.png`, fullPage: true });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test('a PO of the same organization sees nothing of it', async ({ page }) => {
  await login(page, 'cu.po@browser.test');
  await expect(page.getByLabel('Operação do PO')).toBeVisible();
  await expect(page.getByText('ClickUp')).toHaveCount(0);
  const status = await page.evaluate(
    async () => (await fetch('/api/clickup/sync-runs')).status,
  );
  expect(status).toBe(403);
});

test('another organization, with the integration off, has no trace of it', async ({
  page,
}) => {
  await login(page, 'demo.gestor@browser.test');
  await expect(page.getByLabel('Visão executiva')).toBeVisible();
  await expect(page.getByText('ClickUp')).toHaveCount(0);
  const status = await page.evaluate(
    async () => (await fetch('/api/clickup/sync-runs')).status,
  );
  expect(status).toBe(404);
});
