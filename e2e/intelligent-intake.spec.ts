import { test, expect } from '@playwright/test';
import { login } from './login';
import { open } from './nav';
import { syntheticSource } from '../tests/support/extraction-fixture';
test('M2 synthetic meeting → three AI proposals → review → two approved and one rejected → traceable Mission Control', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await login(page, 'po@browser.test');
  await open(page, 'Clientes e projetos');
  await page
    .getByLabel('Nome do cliente', { exact: true })
    .fill('IA Cliente Sintético');
  await page.getByRole('button', { name: 'Cadastrar cliente' }).click();
  await page
    .getByRole('combobox', { name: 'Cliente', exact: true })
    .selectOption({ label: 'IA Cliente Sintético' });
  await page.getByLabel('Nome do projeto').fill('IA Projeto Sintético');
  await page
    .getByRole('button', { name: 'Criar projeto', exact: true })
    .click();
  await page
    .getByRole('combobox', { name: 'Projeto', exact: true })
    .selectOption({ label: 'IA Cliente Sintético / IA Projeto Sintético' });
  await page.getByLabel('Resumo e contexto').fill(syntheticSource);
  await page
    .getByRole('button', { name: 'Registrar atendimento', exact: true })
    .click();
  await open(page, 'Atendimento inteligente');
  const intake = page.getByRole('region', {
    name: 'Atendimento inteligente',
    exact: true,
  });
  const select = intake.getByRole('combobox', {
    name: 'Atendimento para extração',
    exact: true,
  });
  const option = select
    .locator('option')
    .filter({ hasText: 'Reunião sintética da Loja Aurora.' });
  await expect(option).toHaveCount(1);
  await select.selectOption((await option.getAttribute('value'))!);
  await intake
    .getByRole('checkbox', { name: 'Confirmo a classificação', exact: false })
    .check();
  await intake
    .getByRole('button', { name: 'Extrair com IA', exact: true })
    .click();
  const review = intake.getByRole('region', {
    name: 'Revisão da extração',
    exact: true,
  });
  await expect(
    review.getByRole('heading', { name: 'Pronta para revisão', exact: true }),
  ).toBeVisible({ timeout: 10000 });
  await expect(review.locator('article')).toHaveCount(3);
  const first = review.getByRole('article', {
    name: 'Proposta Rastreamento de pedidos',
    exact: true,
  });
  const second = review.getByRole('article', {
    name: 'Proposta Exportação CSV',
    exact: true,
  });
  const third = review.getByRole('article', {
    name: 'Proposta Alerta de estoque',
    exact: true,
  });
  await expect(first).toContainText(
    'Solicitamos rastreamento de pedidos no portal.',
  );
  await first
    .getByRole('button', { name: 'Editar proposta', exact: true })
    .click();
  const edit = review.getByRole('form', {
    name: 'Editar proposta',
    exact: true,
  });
  await edit
    .getByLabel('Título revisado')
    .fill('Rastreamento validado pelo PO');
  await edit.getByRole('button', { name: 'Salvar revisão' }).click();
  await expect(edit).toHaveCount(0);
  await third
    .getByRole('button', { name: 'Rejeitar proposta', exact: true })
    .click();
  await expect(third).toContainText('Rejeitada');
  const edited = review.getByRole('article', {
    name: 'Proposta Rastreamento validado pelo PO',
    exact: true,
  });
  await edited
    .getByRole('checkbox', { name: 'Selecionar para criar demanda' })
    .check();
  await second
    .getByRole('checkbox', { name: 'Selecionar para criar demanda' })
    .check();
  const approval = review.getByRole('form', {
    name: 'Confirmar demandas',
    exact: true,
  });
  await approval
    .getByRole('combobox', { name: 'Responsável pelas demandas' })
    .selectOption({ label: 'Dev Browser · dev@browser.test' });
  await approval
    .getByLabel('Próxima ação das demandas')
    .fill('Estimar com engenharia');
  await approval
    .getByRole('checkbox', { name: 'Revisei a origem', exact: false })
    .check();
  await approval
    .getByRole('button', { name: 'Criar demandas selecionadas' })
    .click();
  await expect(intake.getByRole('status')).toContainText('2 demandas criadas');
  await open(page, 'Solicitações');
  const cards = page.locator('article.request').filter({
    has: page.getByRole('button', { name: 'Atualizar solicitação' }),
  });
  const a = cards.filter({
    has: page.getByRole('heading', {
      name: 'Rastreamento validado pelo PO',
      exact: true,
    }),
  });
  const b = cards.filter({
    has: page.getByRole('heading', { name: 'Exportação CSV', exact: true }),
  });
  await expect(a).toContainText('Dev Browser');
  await expect(a).toContainText('Estimar com engenharia');
  await expect(a).toContainText('Origem IA revisada por humano');
  await expect(b).toBeVisible();
  await expect(
    cards.filter({
      has: page.getByRole('heading', {
        name: 'Alerta de estoque',
        exact: true,
      }),
    }),
  ).toHaveCount(0);
  // Returning to the module keeps the reviewed extraction open.
  await open(page, 'Atendimento inteligente');
  await expect(review).toContainText('accepted');
  await expect(review).toContainText('rejected');
  await open(page, 'Solicitações');
  await page.screenshot({
    path: 'test-results/m2-human-reviewed.png',
    fullPage: true,
  });
  await page.reload();
  await expect(
    page.getByRole('heading', {
      name: 'Rastreamento validado pelo PO',
      exact: true,
    }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
