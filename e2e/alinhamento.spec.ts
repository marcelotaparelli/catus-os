import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { open } from './nav';
import { Meter, api } from './support-ux/meter';
import { demand, intake, team, testDb } from './support-ops/seed';

// Alinhamento e Aceite in a real browser, with synthetic people: what each role can do, and
// what each task costs, measured with the same Meter as the other tasks.
test.use({ actionTimeout: 15000 });
const OUT = process.env.AA_EVIDENCE ?? 'test-results/alinhamento-aceite';
const queueOf = (p: Page) => p.getByRole('region', { name: 'Fila de ações' });
const itemOf = (p: Page, title: string) =>
  queueOf(p).getByRole('listitem').filter({ hasText: title });
const button = (p: Page, title: string, label: string) =>
  itemOf(p, title).getByRole('button', { name: `${label}: ${title}` });
async function openQueue(p: Page) {
  await open(p, 'Clientes e projetos');
  await open(p, 'Solicitações');
  await expect(queueOf(p).getByRole('heading', { level: 2 })).toBeVisible();
}
const noSeriousAxe = async (p: Page, label: string) => {
  const { violations } = await new AxeBuilder({ page: p })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(
    violations
      .filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))
      .map((v) => `${label}: ${v.id}`),
  ).toEqual([]);
};
const walk = async (p: Page, id: string, to: string) => {
  const r = await api<{
    status: string;
    owner_user_id: string;
    next_action: string;
    version: number;
  }>(p, `followup`).then((q: any) =>
    q.items.find((i: { id: string }) => i.id === id),
  );
  return api<{ version: number }>(p, `requests/${id}`, 'PATCH', {
    status: to,
    owner_user_id: r.owner_user_id,
    next_action: r.next_action,
    version: r.version,
  });
};

test('from agreement to acceptance: right people, evidence, trail and effort', async ({
  browser,
}) => {
  test.setTimeout(300000);
  mkdirSync(OUT, { recursive: true });
  const db = testDb();
  const { pages, ids } = await team(browser);
  const { po, manager, dev } = pages;
  const c = await intake(po, 'Horizonte (sintético)');
  const effort: Record<string, unknown> = {};
  const errors: string[] = [];
  for (const p of [po, manager, dev])
    p.on('pageerror', (e) => errors.push(e.message));

  const title = 'Implantar frete por região';
  const d = await demand(po, c.id, title, ids.dev, { template: 'implantacao' });
  // Criteria that already exist for the demand come filled in.
  await db.query(
    'UPDATE requests SET suggested_acceptance_criteria=$2::jsonb WHERE id=$1',
    [
      d.id,
      JSON.stringify([
        {
          text: 'Frete calculado para as 5 regiões',
          quote: 'q',
          start: 0,
          end: 1,
        },
      ]),
    ],
  );
  await walk(po, d.id, 'triage');
  await po.reload();
  await openQueue(po);

  // 1. Agreement, only confirming what came filled in.
  {
    const m = new Meter();
    await m.click(button(po, title, 'Combinado'));
    const form = queueOf(po).getByRole('form', { name: 'Salvar combinado' });
    await expect(form.getByLabel('Critérios de aceite')).toHaveValue(
      'Frete calculado para as 5 regiões',
    );
    await m.click(form.getByRole('button', { name: 'Salvar combinado' }));
    await expect(itemOf(po, title)).toContainText('Critérios de aceite · v1');
    effort.combinado_preenchido = { clicks: m.clicks, fields: m.fields };
  }

  // 2. The client confirms: the most recent interaction is the evidence.
  {
    const m = new Meter();
    await m.click(button(po, title, 'Cliente confirmou'));
    const form = queueOf(po).getByRole('form', {
      name: 'Registrar confirmação',
    });
    await expect(form).toContainText('Atendimento de Horizonte');
    await m.click(form.getByRole('button', { name: 'Registrar confirmação' }));
    await expect(itemOf(po, title)).toContainText('Confirmado pelo cliente');
    effort.confirmacao_com_atendimento = { clicks: m.clicks, fields: m.fields };
    await po.screenshot({
      path: `${OUT}/po-confirmado-1280.png`,
      fullPage: true,
    });
  }

  // 3. The developer executes and delivers, and has nothing to attest with.
  await walk(po, d.id, 'ready');
  await walk(po, d.id, 'in_progress');
  await dev.reload();
  await openQueue(dev);
  await expect(itemOf(dev, title)).toContainText(
    'Frete calculado para as 5 regiões',
  );
  {
    const m = new Meter();
    await m.click(button(dev, title, 'Marcar como entregue'));
    await expect(itemOf(dev, title)).toContainText('Aguardando aceite');
    effort.marcar_entregue = { clicks: m.clicks, fields: m.fields };
  }
  for (const label of [
    'Registrar aceite',
    'Registrar recusa',
    'Concluir sem aceite',
  ])
    await expect(button(dev, title, label)).toHaveCount(0);
  // The full list offers no shortcut around delivery and acceptance.
  await expect(
    dev
      .getByRole('region', { name: 'Solicitações', exact: true })
      .getByRole('button', { name: /Avançar: Concluída/ }),
  ).toHaveCount(0);
  await dev.screenshot({
    path: `${OUT}/dev-entregue-1280.png`,
    fullPage: true,
  });
  await noSeriousAxe(dev, 'desenvolvedor entregue');

  // 4. A refusal goes back with the reason, in the words the PO wrote.
  await po.reload();
  await openQueue(po);
  {
    const m = new Meter();
    await expect(itemOf(po, title)).toContainText('O silêncio do cliente');
    await m.click(button(po, title, 'Registrar recusa'));
    const form = queueOf(po).getByRole('form', { name: 'Registrar recusa' });
    await m.fill(form.getByLabel('O que o cliente disse'), 'Faltou o Norte');
    await m.fill(form.getByLabel('Motivo da recusa'), 'Frete errado no Norte');
    await m.click(form.getByRole('button', { name: 'Registrar recusa' }));
    await expect(itemOf(po, title)).toContainText(
      'Corrigir: Frete errado no Norte',
    );
    effort.recusa_sem_atendimento = { clicks: m.clicks, fields: m.fields };
  }

  // 5. Delivered again, the PO records the acceptance with what the client said.
  await dev.reload();
  await openQueue(dev);
  await button(dev, title, 'Marcar como entregue').click();
  await expect(itemOf(dev, title)).toContainText('Aguardando aceite');
  await po.reload();
  await openQueue(po);
  {
    const m = new Meter();
    await m.click(button(po, title, 'Registrar aceite'));
    const form = queueOf(po).getByRole('form', { name: 'Registrar aceite' });
    await noSeriousAxe(po, 'PO com formulário de aceite');
    await m.fill(
      form.getByLabel('O que o cliente disse'),
      'Aprovado por e-mail',
    );
    await po.setViewportSize({ width: 390, height: 844 });
    expect(
      await po.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await po.screenshot({ path: `${OUT}/po-aceite-390.png`, fullPage: true });
    await po.setViewportSize({ width: 1280, height: 900 });
    await m.click(form.getByRole('button', { name: 'Registrar aceite' }));
    await expect(itemOf(po, title)).toHaveCount(0);
    effort.aceite_sem_atendimento = { clicks: m.clicks, fields: m.fields };
  }
  const trail = await api<{ kind: string; text: string }[]>(
    po,
    `requests/${d.id}/alignment`,
  );
  expect(trail.map((t) => t.kind)).toEqual([
    'agreement',
    'confirmation',
    'delivered',
    'rejected',
    'delivered',
    'accepted',
  ]);
  expect(trail.at(-1)!.text).toContain('Aprovado por e-mail');

  // 6. An acceptance with an interaction already recorded costs no typing.
  {
    const t2 = 'Ajustar checkout';
    const d2 = await demand(po, c.id, t2, ids.dev, { template: 'implantacao' });
    await walk(po, d2.id, 'triage');
    await walk(po, d2.id, 'ready');
    await walk(po, d2.id, 'in_progress');
    const q = await api<any>(po, 'followup');
    const i = q.items.find((x: { id: string }) => x.id === d2.id);
    const a = await api<{ version: number }>(
      po,
      `requests/${d2.id}/alignment`,
      'POST',
      {
        kind: 'agreement',
        criteria: 'Checkout sem erro',
        version: i.version,
      },
    );
    await api(po, `requests/${d2.id}/alignment`, 'POST', {
      kind: 'delivered',
      version: a.version,
    });
    await api(po, 'interactions', 'POST', {
      project_id: c.projectId,
      kind: 'service',
      summary: 'Cliente aprovou o checkout',
      occurred_at: new Date().toISOString(),
    });
    await po.reload();
    await openQueue(po);
    const m = new Meter();
    await m.click(button(po, t2, 'Registrar aceite'));
    const form = queueOf(po).getByRole('form', { name: 'Registrar aceite' });
    await expect(form).toContainText('Cliente aprovou o checkout');
    await m.click(form.getByRole('button', { name: 'Registrar aceite' }));
    await expect(itemOf(po, t2)).toHaveCount(0);
    effort.aceite_com_atendimento = { clicks: m.clicks, fields: m.fields };
  }

  // 7. High risk waits for a person with authority, in the same queue.
  {
    const t3 = 'Migrar base de clientes';
    const d3 = await demand(po, c.id, t3, ids.dev, { template: 'implantacao' });
    await walk(po, d3.id, 'triage');
    await walk(po, d3.id, 'ready');
    await po.reload();
    await openQueue(po);
    await button(po, t3, 'Combinado').click();
    const form = queueOf(po).getByRole('form', { name: 'Salvar combinado' });
    await form.getByLabel('Critérios de aceite').fill('Dados conferidos');
    await form.getByLabel(/Alto risco/).check();
    await form.getByRole('button', { name: 'Salvar combinado' }).click();
    await expect(itemOf(po, t3)).toContainText('Alto risco sem autorização');
    await button(po, t3, 'Iniciar execução').click();
    await queueOf(po)
      .getByRole('region', { name: 'Editar solicitação' })
      .getByRole('button', { name: 'Salvar atualização' })
      .click();
    await expect(po.getByRole('alert')).toContainText('Operação de alto risco');
    await button(po, t3, 'Atualizar').count();
    await expect(button(po, t3, 'Autorizar alto risco')).toHaveCount(0);
    await manager.reload();
    await openQueue(manager);
    await button(manager, t3, 'Autorizar alto risco').click();
    await expect(itemOf(manager, t3)).not.toContainText(
      'Alto risco sem autorização',
    );
    await manager.screenshot({
      path: `${OUT}/gestor-1280.png`,
      fullPage: true,
    });
  }

  await db.end();
  expect(errors).toEqual([]);
  writeFileSync(`${OUT}/esforco.json`, JSON.stringify(effort, null, 2));
  // The limits of the acceptance criteria: 0 typing whenever the answer is already recorded.
  expect(effort.combinado_preenchido).toEqual({ clicks: 2, fields: 0 });
  expect(effort.confirmacao_com_atendimento).toEqual({ clicks: 2, fields: 0 });
  expect(effort.marcar_entregue).toEqual({ clicks: 1, fields: 0 });
  expect(effort.aceite_com_atendimento).toEqual({ clicks: 2, fields: 0 });
  expect(effort.aceite_sem_atendimento).toEqual({ clicks: 2, fields: 1 });
  expect(effort.recusa_sem_atendimento).toEqual({ clicks: 2, fields: 2 });
});
