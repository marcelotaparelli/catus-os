import { test, expect } from '@playwright/test';
import pg from 'pg';
test('manual client → project → meeting → request → Mission Control → update → reload', async ({
  page,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const clientName = `E2E Cliente ${suffix}`;
  const projectName = `E2E Loja ${suffix}`;
  const title = `E2E Checkout ${suffix}`;
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await page.goto('/');
    await page
      .getByLabel('Token de desenvolvimento')
      .fill(process.env.DEV_TOKEN!);
    await page.getByRole('button', { name: 'Conectar', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Registrar contexto' }),
    ).toBeVisible();
    await page.getByLabel('Nome do cliente', { exact: true }).fill(clientName);
    await page.getByRole('button', { name: 'Cadastrar cliente' }).click();
    const clientForm = page
      .locator('form')
      .filter({ has: page.getByRole('heading', { name: '02 · Projeto' }) });
    await clientForm
      .getByRole('combobox', { name: 'Cliente', exact: true })
      .selectOption({ label: clientName });
    await page.getByLabel('Nome do projeto').fill(projectName);
    await page
      .getByRole('button', { name: 'Criar projeto', exact: true })
      .click();
    await page
      .getByRole('combobox', { name: 'Projeto', exact: true })
      .selectOption({ label: `${clientName} / ${projectName}` });
    await page
      .getByLabel('Resumo e contexto')
      .fill(`Pedido de melhoria no checkout ${suffix}`);
    await page
      .getByRole('button', { name: 'Registrar atendimento', exact: true })
      .click();
    await page
      .getByRole('combobox', { name: 'Atendimento de origem', exact: true })
      .selectOption({
        label: `${projectName} · Pedido de melhoria no checkout ${suffix}`,
      });
    await page.getByLabel('Título', { exact: true }).fill(title);
    await page
      .getByLabel('Descrição', { exact: true })
      .fill('Investigar abandono do checkout');
    await page.getByLabel('Responsável', { exact: true }).fill('PO de teste');
    await page
      .getByLabel('Próxima ação', { exact: true })
      .fill('Confirmar requisitos com cliente');
    await page
      .getByRole('button', { name: 'Criar solicitação', exact: true })
      .click();
    const card = page
      .locator('article')
      .filter({ has: page.getByRole('heading', { name: title, exact: true }) });
    await expect(card).toContainText('Nova');
    await expect(card).toContainText('PO de teste');
    await expect(card).toContainText('Confirmar requisitos com cliente');
    await card.getByRole('button', { name: 'Atualizar solicitação' }).click();
    const edit = page.getByRole('region', { name: 'Editar solicitação' });
    await edit
      .getByRole('combobox', { name: 'Estado', exact: true })
      .selectOption('triage');
    await edit.getByLabel('Responsável').fill('Engenharia');
    await edit.getByLabel('Próxima ação').fill('Estimar esforço');
    await edit.getByRole('button', { name: 'Salvar atualização' }).click();
    await expect(card).toContainText('Em triagem');
    await expect(card).toContainText('Engenharia');
    await expect(card).toContainText('Estimar esforço');
    await page.reload();
    await page
      .getByLabel('Token de desenvolvimento')
      .fill(process.env.DEV_TOKEN!);
    await page.getByRole('button', { name: 'Conectar', exact: true }).click();
    await expect(card).toContainText('Em triagem');
    await expect(card).toContainText('Estimar esforço');
    await page.screenshot({
      path: 'test-results/mission-control.png',
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      page.getByRole('heading', { name: 'Mission Control', exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    expect(browserErrors).toEqual([]);
  } finally {
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      const ids = (
        await c.query('SELECT id FROM clients WHERE name=$1', [clientName])
      ).rows.map((r: { id: string }) => r.id);
      for (const id of ids) {
        await c.query(
          'DELETE FROM audit_events WHERE request_id IN (SELECT r.id FROM requests r JOIN interactions i ON i.id=r.interaction_id JOIN projects p ON p.id=i.project_id WHERE p.client_id=$1)',
          [id],
        );
        await c.query(
          'DELETE FROM requests WHERE interaction_id IN (SELECT i.id FROM interactions i JOIN projects p ON p.id=i.project_id WHERE p.client_id=$1)',
          [id],
        );
        await c.query(
          'DELETE FROM interactions WHERE project_id IN (SELECT id FROM projects WHERE client_id=$1)',
          [id],
        );
        await c.query('DELETE FROM projects WHERE client_id=$1', [id]);
        await c.query('DELETE FROM clients WHERE id=$1', [id]);
      }
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
      await db.end();
    }
  }
});
