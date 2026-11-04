import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { open } from './nav';
import { Meter, api } from './support-ux/meter';
import { demand, intake, team, testDb } from './support-ops/seed';
import { buildEcommerceScenario } from '../tests/support/ecommerce-scenario';

// Nenhuma demanda esquecida, in a real browser and through the real API: who sees what, and
// the effort of the same tasks measured in docs/quality/ops-followup/antes/as-is.json.
test.use({ actionTimeout: 15000 });
const OUT = process.env.OPS_EVIDENCE ?? 'test-results/ops-followup';
const FAULT = 'test-results/automation-fault';
const queueOf = (p: Page) => p.getByRole('region', { name: 'Fila de ações' });
const itemOf = (p: Page, title: string) =>
  queueOf(p).getByRole('listitem').filter({ hasText: title });
async function openQueue(p: Page) {
  await open(p, 'Clientes e projetos');
  await open(p, 'Solicitações');
  await expect(queueOf(p).getByRole('heading', { level: 2 })).toBeVisible();
}
const shot = (p: Page, name: string) =>
  p.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });

test('nothing is forgotten: full journey, right people, failure and effort', async ({
  browser,
}) => {
  test.setTimeout(420000);
  mkdirSync(OUT, { recursive: true });
  rmSync(FAULT, { force: true });
  const db = testDb();
  const { pages, ids } = await team(browser);
  const { po, manager, admin, dev, dev2 } = pages;
  const c = await intake(po, 'Aurora (sintético)');
  await po.reload();
  const effort: Record<string, unknown> = {};

  // 1. Register with what the template and the session already know.
  {
    const m = new Meter(),
      t0 = Date.now();
    await open(po, 'Solicitações');
    m.clicks += 1;
    await m.click(
      queueOf(po).getByRole('button', { name: 'Registrar demanda' }),
    );
    const form = queueOf(po).getByRole('form', { name: 'Registrar demanda' });
    await m.fill(form.getByLabel('Título'), 'Corrigir frete na vitrine');
    await m.click(form.getByRole('button', { name: 'Criar demanda' }));
    await expect(queueOf(po).getByRole('status')).toContainText(
      'Demanda registrada',
    );
    effort.registrar = {
      clicks: m.clicks,
      fields: m.fields,
      ms: Date.now() - t0,
      prazo_registrado: true,
    };
    const item = itemOf(po, 'Corrigir frete na vitrine');
    await expect(item).toContainText('Compromisso');
    await expect(item).toContainText('Reproduzir o pedido');
    await expect(item).toContainText('Pia PO');
  }

  // 2. A demand goes to the end: owner, stage, next action reviewed at each step, closed.
  {
    const title = 'Corrigir frete na vitrine',
      m = new Meter(),
      t0 = Date.now();
    await m.click(
      itemOf(po, title).getByRole('button', {
        name: `Atualizar: ${title}`,
      }),
    );
    const edit = queueOf(po).getByRole('region', {
      name: 'Editar solicitação',
    });
    await edit
      .getByRole('combobox', { name: 'Responsável' })
      .selectOption({ value: ids.dev });
    await m.click(edit.getByRole('button', { name: 'Salvar atualização' }));
    await expect(itemOf(po, title)).toContainText('Dan Dev');
    effort.reatribuir = { clicks: m.clicks + 2, fields: m.fields };

    const n = new Meter();
    await n.click(
      itemOf(po, title).getByRole('button', {
        name: `Liberar para execução: ${title}`,
      }),
    );
    // The action is shown and nothing is saved until confirmed.
    const review = queueOf(po).getByRole('region', {
      name: 'Editar solicitação',
    });
    await expect(review.getByRole('combobox', { name: 'Estado' })).toHaveValue(
      'ready',
    );
    await expect(review.getByLabel('Próxima ação')).toHaveValue(
      'Reproduzir o pedido e confirmar o que fazer',
    );
    await n.fill(review.getByLabel('Próxima ação'), 'Corrigir o cálculo');
    await n.click(review.getByRole('button', { name: 'Salvar atualização' }));
    // Released and healthy: it left the PO's queue and is now the developer's.
    await expect(itemOf(po, title)).toHaveCount(0);

    await open(dev, 'Solicitações');
    n.clicks += 1;
    await expect(itemOf(dev, title)).toContainText('Corrigir o cálculo');
    await n.click(
      itemOf(dev, title).getByRole('button', {
        name: `Iniciar execução: ${title}`,
      }),
    );
    const start = queueOf(dev).getByRole('region', {
      name: 'Editar solicitação',
    });
    await n.fill(start.getByLabel('Próxima ação'), 'Publicar a correção');
    await n.click(start.getByRole('button', { name: 'Salvar atualização' }));
    await expect(itemOf(dev, title)).toContainText('Publicar a correção');
    await n.click(
      itemOf(dev, title).getByRole('button', { name: `Concluir: ${title}` }),
    );
    await expect(itemOf(dev, title)).toHaveCount(0);
    effort.ciclo_completo = {
      clicks: n.clicks + 1, // opening the module as the PO
      fields: n.fields,
      ms: Date.now() - t0,
      etapas_manuais: 3,
    };
    // Every step is on record, with its actor.
    const events = (
      await db.query(
        'SELECT e.changes,e.to_status,u.display_name actor FROM request_events e LEFT JOIN users u ON u.id=e.actor_user_id JOIN requests r ON r.id=e.request_id WHERE r.title=$1 ORDER BY e.occurred_at,e.version',
        [title],
      )
    ).rows;
    expect(events.map((e) => e.to_status)).toEqual([
      'new',
      'new',
      'ready',
      'in_progress',
      'done',
    ]);
    expect(events.map((e) => e.actor)).toEqual([
      'Pia PO',
      'Pia PO',
      'Pia PO',
      'Dan Dev',
      'Dan Dev',
    ]);
  }

  // 3. No owner: reaches those who distribute work, never another developer.
  {
    const r = await demand(po, c.id, 'Órfã da manutenção', ids.dev);
    await db.query('UPDATE requests SET owner_user_id=NULL WHERE id=$1', [
      r.id,
    ]);
    await openQueue(po);
    const item = itemOf(po, 'Órfã da manutenção');
    await expect(item).toContainText('Sem responsável');
    await openQueue(dev2);
    await expect(itemOf(dev2, 'Órfã da manutenção')).toHaveCount(0);
    await shot(po, 'po-sem-responsavel-1280');
    const m = new Meter(),
      t0 = Date.now();
    await m.click(item.getByRole('button', { name: 'Assumir', exact: true }));
    await expect(itemOf(po, 'Órfã da manutenção')).not.toContainText(
      'Sem responsável',
    );
    effort.atribuir = {
      clicks: m.clicks,
      fields: m.fields,
      ms: Date.now() - t0,
    };
  }

  // 4. No contract: maintenance only asks once work starts; a decision stays commercial.
  {
    let r = await demand(po, c.id, 'Fora do contrato', ids.dev);
    const move = async (status: string) =>
      (r = await api(po, `requests/${r.id}`, 'PATCH', {
        status,
        owner_user_id: ids.dev,
        next_action: 'Próximo passo de Fora do contrato',
        version: r.version,
      }));
    await move('ready');
    await openQueue(po);
    await expect(itemOf(po, 'Fora do contrato')).toHaveCount(0);
    await move('in_progress');
    await openQueue(po);
    const item = itemOf(po, 'Fora do contrato');
    await expect(item).toContainText('Em execução sem cobertura');
    await expect(
      item.getByRole('link', { name: 'Analisar cobertura' }),
    ).toHaveAttribute('href', new RegExp(`demanda=${r.id}`));
    await expect(
      queueOf(po).getByRole('listitem').first(),
      'work outside a contract comes first',
    ).toContainText('Fora do contrato');
    await openQueue(dev);
    await expect(itemOf(dev, 'Fora do contrato')).toContainText(
      'Em execução sem cobertura',
    );
    await expect(
      itemOf(dev, 'Fora do contrato').getByRole('link', {
        name: 'Analisar cobertura',
      }),
    ).toHaveCount(0);
  }

  // 5. Client late: structured block, due date, and it appears for the right people only.
  {
    const title = 'Aguardando cliente',
      r = await demand(po, c.id, title, ids.dev),
      m = new Meter(),
      t0 = Date.now();
    await openQueue(po);
    await m.click(
      itemOf(po, title).getByRole('button', {
        name: `Liberar para execução: ${title}`,
      }),
    );
    await m.click(
      queueOf(po)
        .getByRole('region', { name: 'Editar solicitação' })
        .getByRole('button', { name: 'Salvar atualização' }),
    );
    await expect(itemOf(po, title)).toHaveCount(0);
    await openQueue(dev);
    m.clicks += 1;
    await m.click(
      itemOf(dev, title).getByRole('button', { name: `Bloquear: ${title}` }),
    );
    const edit = queueOf(dev).getByRole('region', {
      name: 'Editar solicitação',
    });
    await expect(edit.getByRole('combobox', { name: 'Estado' })).toHaveValue(
      'blocked',
    );
    await m.fill(
      edit.getByLabel('Motivo do bloqueio'),
      'Faltam as credenciais',
    );
    await m.click(edit.getByRole('button', { name: 'Salvar atualização' }));
    await expect(itemOf(dev, title)).toContainText('Faltam as credenciais');
    await expect(itemOf(dev, title)).toContainText('Depende de');
    effort.bloquear = {
      clicks: m.clicks,
      fields: m.fields,
      ms: Date.now() - t0,
      motivo_estruturado: true,
      retorno_estruturado: true,
    };
    await db.query(
      'UPDATE requests SET follow_up_on=current_date-3 WHERE id=$1',
      [r.id],
    );
    for (const p of [po, manager, dev]) {
      await openQueue(p);
      await expect(itemOf(p, title)).toContainText('Cliente em atraso');
      await expect(itemOf(p, title)).toContainText('há 3 dias');
    }
    await openQueue(dev2);
    await expect(itemOf(dev2, title)).toHaveCount(0);
    await shot(dev, 'dev-cliente-em-atraso-1280');
    // The Mission Control points to it, with no extra call at start.
    await open(dev, 'Mission Control');
    await expect(dev.getByRole('main')).toContainText(/na sua fila de ações/);
  }

  // 6. Overdue, not client: owner and manager; stalled work: its owner.
  {
    const late = await demand(po, c.id, 'Compromisso perdido', ids.dev2),
      idle = await demand(po, c.id, 'Sem movimento', ids.dev2);
    await db.query(
      'UPDATE requests SET follow_up_on=current_date-1 WHERE id=$1',
      [late.id],
    );
    await db.query(
      "UPDATE requests SET updated_at=now()-interval '10 days' WHERE id=$1",
      [idle.id],
    );
    await openQueue(dev2);
    await expect(itemOf(dev2, 'Compromisso perdido')).toContainText(
      'Compromisso vencido',
    );
    await expect(itemOf(dev2, 'Sem movimento')).toContainText('Parada');
    await openQueue(dev);
    await expect(itemOf(dev, 'Compromisso perdido')).toHaveCount(0);
    await openQueue(manager);
    await expect(
      queueOf(manager).getByRole('list', { name: /^Com você/ }),
    ).toContainText('Compromisso perdido');
    // Finding the same situations, as in the "before" run.
    const m = new Meter(),
      t0 = Date.now();
    await open(po, 'Clientes e projetos');
    await open(po, 'Solicitações');
    m.clicks += 1;
    await expect(queueOf(po)).toContainText('Cliente em atraso');
    const text = await queueOf(po).innerText();
    effort.localizar = {
      clicks: m.clicks,
      fields: m.fields,
      ms: Date.now() - t0,
      cartoes_para_ler: await queueOf(po)
        .getByRole('list', { name: /^Com você/ })
        .getByRole('listitem')
        .count(),
      sinais_na_tela: {
        sem_responsavel: true, // proven in step 3
        bloqueada: /Cliente em atraso|Bloqueada/.test(text),
        sem_cobertura: /sem cobertura/i.test(text),
        parada: true, // proven above for its owner
        vencida: true, // proven above for owner and manager
        atraso_cliente: /Cliente em atraso/.test(text),
      },
      prazo_na_tela: /Compromisso/.test(text),
    };
    await shot(po, 'po-fila-depois-1280');
  }

  // 7. Excess of work: one person with too much at once, named to those who distribute it.
  {
    for (let i = 1; i <= 6; i++) {
      let r = await demand(po, c.id, `Frente ${i}`, ids.dev2);
      for (const status of ['ready', 'in_progress'])
        r = await api(po, `requests/${r.id}`, 'PATCH', {
          status,
          owner_user_id: ids.dev2,
          next_action: `Seguir a frente ${i}`,
          version: r.version,
        });
    }
    await openQueue(manager);
    await expect(queueOf(manager)).toContainText(
      'Excesso de trabalho: Eva Dev tem 6 demandas em execução',
    );
    await openQueue(dev2);
    await expect(queueOf(dev2)).not.toContainText('Excesso de trabalho');
  }

  // 8. Automation failing: work continues, nothing is lost, it recovers without repeating.
  {
    writeFileSync(FAULT, 'simulated');
    const title = 'Durante a falha',
      r = await demand(po, c.id, title, ids.dev);
    await db.query(
      'UPDATE requests SET follow_up_on=current_date-2 WHERE id=$1',
      [r.id],
    );
    // A critical transaction still commits and the queue, computed on read, is right.
    await openQueue(dev);
    await expect(itemOf(dev, title)).toContainText('Compromisso vencido');
    await expect(itemOf(dev, title)).not.toContainText('novo');
    await expect
      .poll(
        async () =>
          (await api<{ automation: { retrying: number } }>(admin, 'followup'))
            .automation.retrying,
        { timeout: 20000 },
      )
      .toBeGreaterThan(0);
    await openQueue(admin);
    await expect(queueOf(admin)).toContainText('Automação com atraso');
    await shot(admin, 'admin-automacao-com-falha-1280');
    await openQueue(po);
    await expect(queueOf(po)).not.toContainText('Automação com atraso');
    expect(
      (
        await db.query(
          "SELECT count(*)::int n FROM request_events WHERE request_id=$1 AND 'created'=ANY(changes)",
          [r.id],
        )
      ).rows[0].n,
    ).toBe(1);

    rmSync(FAULT, { force: true });
    await expect
      .poll(
        async () =>
          (
            await db.query(
              "SELECT count(*)::int n FROM demand_alerts WHERE request_id=$1 AND kind='overdue' AND resolved_at IS NULL",
              [r.id],
            )
          ).rows[0].n,
        { timeout: 60000 },
      )
      .toBe(1);
    await openQueue(dev);
    await expect(itemOf(dev, title)).toContainText('novo');
    // Seen once: stays in the queue, is not announced again by later sweeps.
    await queueOf(dev)
      .getByRole('button', { name: /^Marcar avisos como vistos/ })
      .click();
    await expect(itemOf(dev, title)).not.toContainText('novo');
    await dev.waitForTimeout(6000);
    await openQueue(dev);
    await expect(itemOf(dev, title)).toContainText('Compromisso vencido');
    await expect(itemOf(dev, title)).not.toContainText('novo');
  }

  // 9. Hours over the estimate: only for who may read them, with the economics untouched.
  {
    await buildEcommerceScenario(
      (who, path, method = 'GET', body) => api(pages[who], path, method, body),
      ids,
    );
    const { records } = await api<{
      records: {
        kind: string;
        project_id: string;
        decision: string;
        payload: { request_id: string; planned_minutes: number };
      }[];
    }>(manager, 'economics');
    const snapshot = await api<{
      requests: {
        id: string;
        title: string;
        owner_user_id: string;
        status: string;
      }[];
    }>(manager, 'mission-control');
    const estimate = records.find(
      (e) =>
        e.kind === 'estimate' &&
        e.decision === 'approved' &&
        snapshot.requests.some(
          (r) =>
            r.id === e.payload.request_id &&
            r.owner_user_id === ids.dev &&
            r.status !== 'done',
        ),
    )!;
    const over = snapshot.requests.find(
      (r) => r.id === estimate.payload.request_id,
    )!;
    await api(dev, 'economics/times', 'POST', {
      project_id: estimate.project_id,
      request_id: over.id,
      work_date: new Date().toISOString().slice(0, 10),
      minutes: 1400,
      comment: 'SINTÉTICO · excesso',
      replaces_id: null,
    });
    await api(dev, 'economics/times', 'POST', {
      project_id: estimate.project_id,
      request_id: over.id,
      work_date: new Date(Date.now() - 864e5).toISOString().slice(0, 10),
      minutes: 1400,
      comment: 'SINTÉTICO · excesso 2',
      replaces_id: null,
    });
    await openQueue(manager);
    await expect(itemOf(manager, over.title)).toContainText(
      'Acima das horas estimadas',
    );
    for (const p of [po, dev]) {
      await openQueue(p);
      await expect(queueOf(p)).not.toContainText('Acima das horas estimadas');
    }
  }

  // Accessibility and narrow screens, on the populated queue.
  for (const [name, p] of [
    ['po', po],
    ['dev', dev],
  ] as const) {
    await openQueue(p);
    const { violations } = await new AxeBuilder({ page: p })
      .include('section[aria-label="Fila de ações"]')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(
      violations
        .filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))
        .map((v) => v.id),
    ).toEqual([]);
    await p.setViewportSize({ width: 390, height: 844 });
    expect(
      await p.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await shot(p, `${name}-fila-390`);
    await p.setViewportSize({ width: 1280, height: 900 });
  }
  writeFileSync(`${OUT}/depois.json`, JSON.stringify(effort, null, 2));
  await db.end();
});
