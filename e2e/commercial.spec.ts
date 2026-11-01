import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { login } from './login';
async function selectVersion(page: Page, n: number) {
  const control = page.getByRole('region', { name: 'Controle comercial' });
  const select = control.getByRole('combobox', {
    name: 'Versão de escopo',
    exact: true,
  });
  const option = select
    .locator('option')
    .filter({ hasText: `M3 Projeto Sintético · V${n} ·` });
  await expect(option).toHaveCount(1);
  await select.selectOption((await option.getAttribute('value'))!);
}
async function itemForm(
  page: Page,
  description = 'Checkout sintético contratado',
) {
  const form = page.getByRole('form', { name: 'Preparar versão de escopo' });
  await form.getByLabel('Descrição do item', { exact: true }).fill(description);
  await form
    .getByLabel('Entregáveis', { exact: true })
    .fill('Checkout demonstrável');
  await form
    .getByLabel('Exclusões', { exact: true })
    .fill('Campanhas e meios de pagamento externos');
  await form
    .getByLabel('Critérios de aceite contratual', { exact: true })
    .fill('Checkout finaliza pedido sintético');
  await form
    .getByLabel('Dependências', { exact: true })
    .fill('Layout aprovado');
  const select = form.getByRole('combobox', {
    name: 'Atendimento de origem comercial',
    exact: true,
  });
  const option = select
    .locator('option')
    .filter({ hasText: 'SYNTHETIC M3 reunião de checkout' });
  await select.selectOption((await option.getAttribute('value'))!);
}
test('M3 PO prepares V1, manager approves, explicit coverage, change V2 preserves V1 and requires new approval; foreign organization isolated', async ({
  page,
  browser,
}) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await login(page, 'po@browser.test');
  await page
    .getByLabel('Nome do cliente', { exact: true })
    .fill('M3 Cliente Sintético');
  await page
    .getByRole('button', { name: 'Cadastrar cliente', exact: true })
    .click();
  await page
    .getByRole('combobox', { name: 'Cliente', exact: true })
    .selectOption({ label: 'M3 Cliente Sintético' });
  await page
    .getByLabel('Nome do projeto', { exact: true })
    .fill('M3 Projeto Sintético');
  await page
    .getByRole('button', { name: 'Criar projeto', exact: true })
    .click();
  await page
    .getByRole('combobox', { name: 'Projeto', exact: true })
    .selectOption({ label: 'M3 Cliente Sintético / M3 Projeto Sintético' });
  await page
    .getByLabel('Resumo e contexto')
    .fill('SYNTHETIC M3 reunião de checkout; cupons fora do escopo inicial.');
  await page
    .getByRole('button', { name: 'Registrar atendimento', exact: true })
    .click();
  const commercial = page.getByRole('region', { name: 'Controle comercial' });
  await commercial.getByText('Cadastrar contrato', { exact: true }).click();
  await commercial
    .getByRole('combobox', { name: 'Projeto contratual', exact: true })
    .selectOption({ label: 'M3 Projeto Sintético' });
  await commercial
    .getByLabel('Título do contrato')
    .fill('M3 Contrato Sintético');
  await commercial.getByLabel('Vigência inicial (UTC)').fill('2020-01-01');
  await commercial.getByLabel('Vigência final (UTC)').fill('2099-12-31');
  await commercial
    .getByLabel('Referência documental')
    .fill('SYNTHETIC-M3-DOC-001');
  await commercial
    .getByRole('button', { name: 'Registrar contrato', exact: true })
    .click();
  await expect(
    commercial.getByRole('heading', {
      name: 'M3 Contrato Sintético',
      exact: true,
    }),
  ).toBeVisible();
  const adminCtx = await browser.newContext(),
    managerCtx = await browser.newContext(),
    foreignCtx = await browser.newContext();
  try {
    const admin = await adminCtx.newPage();
    await login(admin, 'admin@browser.test');
    const ac = admin.getByRole('region', { name: 'Controle comercial' });
    await ac
      .getByText('Configurar alçadas comerciais', { exact: true })
      .click();
    await ac.getByRole('button', { name: 'Salvar alçadas' }).click();
    await expect(ac.getByRole('status')).toContainText('Política v1');
    const manager = await managerCtx.newPage();
    manager.on('pageerror', (e) => errors.push(e.message));
    await login(manager, 'manager@browser.test');
    const mc = manager.getByRole('region', { name: 'Controle comercial' });
    const contract = mc.locator('article').filter({
      has: manager.getByRole('heading', {
        name: 'M3 Contrato Sintético',
        exact: true,
      }),
    });
    await contract
      .getByRole('button', { name: 'Registrar contrato como ativo' })
      .click();
    await expect(contract).toContainText('Ativo');
    await commercial
      .getByRole('button', { name: 'Atualizar comercial', exact: true })
      .click();
    await commercial
      .getByRole('button', { name: 'Preparar escopo inicial' })
      .click();
    const form = page.getByRole('form', { name: 'Preparar versão de escopo' });
    await form
      .getByRole('combobox', { name: 'Projeto do escopo', exact: true })
      .selectOption({ label: 'M3 Projeto Sintético' });
    await form
      .getByRole('combobox', { name: 'Contrato do escopo', exact: true })
      .selectOption({ label: 'M3 Contrato Sintético' });
    await form.getByLabel('Título da versão').fill('Checkout V1');
    await itemForm(page);
    await form
      .getByRole('button', { name: 'Salvar rascunho de escopo' })
      .click();
    const detail = commercial.getByLabel('Detalhe do escopo', { exact: true });
    await expect(detail).toContainText('Rascunho');
    await detail
      .getByRole('button', { name: 'Submeter escopo', exact: true })
      .click();
    await expect(detail).toContainText('Submetido');
    await expect(
      detail.getByRole('button', { name: 'Aprovar escopo', exact: true }),
    ).toHaveCount(0);
    // API negative using the actual PO session: no authority is granted by frontend.
    const session = await (await page.request.get('/api/session')).json();
    const submitted = (
      await (await page.request.get('/api/commercial')).json()
    ).scopes.find((s: { title: string }) => s.title === 'Checkout V1');
    const denied = await page.request.post(
      '/api/scopes/' + submitted.id + '/decide',
      {
        headers: {
          Origin: 'http://127.0.0.1:5173',
          'X-CSRF-Token': session.csrfToken,
          'Idempotency-Key': crypto.randomUUID(),
        },
        data: {
          version: submitted.version,
          decision: 'approved',
          reason: 'No authority',
        },
      },
    );
    expect(denied.status()).toBe(403);
    await mc
      .getByRole('button', { name: 'Atualizar comercial', exact: true })
      .click();
    await selectVersion(manager, 1);
    await mc
      .getByLabel('Justificativa da decisão')
      .fill('Conferido contrato sintético e critérios V1');
    await mc
      .getByRole('button', { name: 'Aprovar escopo', exact: true })
      .click();
    await expect(
      mc.getByLabel('Detalhe do escopo', { exact: true }),
    ).toContainText('Estado comercial: Aprovado');
    await commercial
      .getByRole('button', { name: 'Atualizar comercial', exact: true })
      .click();
    for (const title of ['M3 Checkout coberto', 'M3 Cupom fora do escopo']) {
      const select = page.getByRole('combobox', {
        name: 'Atendimento de origem',
        exact: true,
      });
      const option = select
        .locator('option')
        .filter({ hasText: 'SYNTHETIC M3 reunião de checkout' });
      await select.selectOption((await option.getAttribute('value'))!);
      await page.getByLabel('Título', { exact: true }).fill(title);
      await page
        .getByLabel('Descrição', { exact: true })
        .fill('Solicitação sintética M3');
      await page
        .getByRole('combobox', { name: 'Responsável', exact: true })
        .selectOption({ label: 'Dev Browser · dev@browser.test' });
      await page
        .getByLabel('Próxima ação', { exact: true })
        .fill('Revisar cobertura');
      await page
        .getByRole('button', { name: 'Criar solicitação', exact: true })
        .click();
      await expect(
        page.getByRole('heading', { name: title, exact: true }),
      ).toBeVisible();
    }
    const coverage = commercial.getByRole('form', {
      name: 'Revisar cobertura comercial',
    });
    await coverage
      .getByRole('combobox', { name: 'Demanda para cobertura', exact: true })
      .selectOption({ label: 'M3 Checkout coberto' });
    await coverage
      .getByRole('combobox', { name: 'Item de escopo aprovado', exact: true })
      .selectOption({ label: 'V1 · Checkout sintético contratado' });
    await coverage.getByRole('button', { name: 'Confirmar cobertura' }).click();
    const covered = page.locator('article.request').filter({
        has: page.getByRole('heading', {
          name: 'M3 Checkout coberto',
          exact: true,
        }),
      }),
      outside = page.locator('article.request').filter({
        has: page.getByRole('heading', {
          name: 'M3 Cupom fora do escopo',
          exact: true,
        }),
      });
    await expect(covered).toContainText('Cobertura comercial aprovada');
    await expect(outside).toContainText('Pendente de análise comercial');
    await detail
      .getByLabel('Motivo da alteração')
      .fill('Incluir cupom sintético');
    await detail
      .getByLabel('Impacto descritivo')
      .fill('Novo entregável e critério; nenhuma estimativa financeira');
    await detail.getByRole('button', { name: 'Criar change request' }).click();
    await expect(detail).toContainText('V2');
    await itemForm(page, 'Checkout e cupom contratados');
    await form.getByLabel('Título da versão').fill('Checkout V2 com cupom');
    await form
      .getByRole('button', { name: 'Salvar rascunho de escopo' })
      .click();
    await detail
      .getByRole('button', { name: 'Submeter escopo', exact: true })
      .click();
    await expect(detail).toContainText('Submetido');
    await expect(outside).toContainText('Pendente de análise comercial');
    await expect(covered).toContainText('Cobertura comercial aprovada');
    await mc
      .getByRole('button', { name: 'Atualizar comercial', exact: true })
      .click();
    await selectVersion(manager, 2);
    await mc
      .getByLabel('Justificativa da decisão')
      .fill('Change request autorizado após revisão');
    await mc
      .getByRole('button', { name: 'Aprovar escopo', exact: true })
      .click();
    await expect(
      mc.getByLabel('Detalhe do escopo', { exact: true }),
    ).toContainText('Estado comercial: Aprovado');
    await commercial
      .getByRole('button', { name: 'Atualizar comercial', exact: true })
      .click();
    await selectVersion(page, 1);
    await expect(detail).toContainText('Substituído');
    await expect(detail).toContainText('Checkout sintético contratado');
    await expect(detail).toContainText(
      'Conferido contrato sintético e critérios V1',
    );
    await expect(covered).toContainText('Pendente de análise comercial');
    await coverage
      .getByRole('combobox', { name: 'Demanda para cobertura', exact: true })
      .selectOption({ label: 'M3 Cupom fora do escopo' });
    await coverage
      .getByRole('combobox', { name: 'Item de escopo aprovado', exact: true })
      .selectOption({ label: 'V2 · Checkout e cupom contratados' });
    await coverage.getByRole('button', { name: 'Confirmar cobertura' }).click();
    await expect(outside).toContainText('Cobertura comercial aprovada');
    await page.reload();
    await expect(outside).toContainText('Cobertura comercial aprovada');
    await expect(covered).toContainText('Pendente de análise comercial');
    await selectVersion(page, 1);
    await expect(detail).toContainText('Substituído');
    await page.screenshot({
      path: 'test-results/m3-scope-contracts.png',
      fullPage: true,
    });
    const foreign = await foreignCtx.newPage();
    await login(foreign, 'outsider@browser.test');
    await expect(
      foreign.getByRole('heading', {
        name: 'M3 Contrato Sintético',
        exact: true,
      }),
    ).toHaveCount(0);
    const fv = await (await foreign.request.get('/api/commercial')).json();
    expect(fv.contracts).toEqual([]);
    expect(fv.scopes).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await Promise.all([
      adminCtx.close(),
      managerCtx.close(),
      foreignCtx.close(),
    ]);
  }
});
