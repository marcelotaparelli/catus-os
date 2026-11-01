import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { login } from './login';
import { governedTask } from '../tests/support/delivery-governance';
import type { TestApi } from '../tests/support/delivery-governance';
test('M5 M2-approved synthetic request → governed M3/M4 → automatic queue → real isolated fixture runner → tests/diff → human review', async ({
  page,
  browser,
}) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await login(page, 'manager@browser.test');
  const adminContext = await browser.newContext(),
    poContext = await browser.newContext();
  try {
    const admin = await adminContext.newPage(),
      po = await poContext.newPage();
    await login(admin, 'admin@browser.test');
    await login(po, 'po@browser.test');
    const pages: Record<string, Page> = { manager: page, admin, po };
    const api: TestApi = async (who, path, body, method) => {
      const p = pages[who]!;
      const session = await (await p.request.get('/api/session')).json();
      const r = await p.request.fetch('/api/' + path, {
        method: method ?? (body === undefined ? 'GET' : 'POST'),
        headers: {
          Origin: 'http://127.0.0.1:5173',
          'X-CSRF-Token': session.csrfToken,
          'Idempotency-Key': crypto.randomUUID(),
        },
        ...(body === undefined ? {} : { data: body }),
      });
      expect(r.ok(), path + ' ' + (await r.text())).toBe(true);
      return r.json();
    };
    const members = await (await po.request.get('/api/members')).json(),
      developer = members.find(
        (m: { email: string }) => m.email === 'dev@browser.test',
      ).id;
    const governed = await governedTask(api, developer, async () => {});
    await page
      .getByRole('button', { name: 'Atualizar dados', exact: true })
      .click();
    await po
      .getByRole('button', { name: 'Atualizar dados', exact: true })
      .click();
    const control = page.getByRole('region', { name: 'Entrega agêntica' }),
      pc = po.getByRole('region', { name: 'Entrega agêntica' });
    await pc.getByText('Preparar tarefa Nuvemshop', { exact: true }).click();
    const sf = pc.getByRole('form', { name: 'Especificação para agente' });
    await sf
      .getByRole('combobox', { name: 'Demanda Nuvemshop', exact: true })
      .selectOption(governed.requestId);
    await sf
      .getByLabel('Especificação sintética para engenharia')
      .fill(
        'Corrigir o título acessível do tema Nuvemshop sintético, preservando a seção hero e os demais arquivos.',
      );
    await sf
      .getByLabel('Critérios de aceite para o runner')
      .fill(
        'O h1 deve ser Bem-vindo à loja sintética; testes reais passam; sem merge e deploy.',
      );
    await sf
      .getByRole('button', { name: 'Registrar especificação de engenharia' })
      .click();
    await expect(pc).toContainText('Política de execução desativada/ausente');
    await control.getByRole('button', { name: 'Atualizar entrega' }).click();
    await control
      .getByText('Autorizar política restrita de execução', { exact: true })
      .click();
    const pf = control.getByRole('form', { name: 'Política de execução' });
    await pf
      .getByRole('combobox', { name: 'Projeto da política', exact: true })
      .selectOption(governed.projectId);
    await pf
      .getByRole('combobox', { name: 'Repositório permitido', exact: true })
      .selectOption('synthetic-nuvemshop');
    await pf
      .getByRole('checkbox', { name: 'templates/home.tpl', exact: true })
      .check();
    await pf
      .getByLabel('Preço de entrada em microUSD por milhão de tokens')
      .fill('1000000');
    await pf
      .getByLabel('Preço de saída em microUSD por milhão de tokens')
      .fill('2000000');
    await pf.getByLabel('Teto por job em microUSD').fill('100000');
    await pf.getByLabel('Teto diário em microUSD').fill('1000000');
    await pf.getByLabel('Teto total em microUSD').fill('10000000');
    await pf
      .getByLabel('Justificativa e autorização de execução')
      .fill(
        'Autorizar exclusivamente fixture sintético Nuvemshop no runner isolado de testes.',
      );
    await pf
      .getByRole('checkbox', {
        name: 'Ativar delegação automática',
        exact: false,
      })
      .check();
    await pf
      .getByRole('button', { name: 'Salvar política de execução' })
      .click();
    await expect(control).toContainText(
      'Última observação M4 exige aprovação independente',
    );
    await expect(
      control.getByRole('article', { name: /^Job de entrega/ }),
    ).toHaveCount(0);
    const ac = admin.getByRole('region', { name: 'Entrega agêntica' });
    await ac.getByRole('button', { name: 'Atualizar entrega' }).click();
    const ef = ac.getByRole('form', {
      name: 'Aprovar observação para execução',
    });
    await ef
      .getByRole('combobox', {
        name: 'Observação M4 para execução',
        exact: true,
      })
      .selectOption(governed.reportId);
    await ef
      .getByLabel('Justificativa de revisão M4')
      .fill(
        'Observação completa e rastreável conferida independentemente para execução sintética.',
      );
    await ef
      .getByRole('button', { name: 'Aprovar observação para execução' })
      .click();
    await control.getByRole('button', { name: 'Atualizar entrega' }).click();
    const job = control
      .getByRole('article', { name: /^Job de entrega/ })
      .filter({
        has: page.getByRole('heading', {
          name: 'Título acessível Nuvemshop sintético',
          exact: true,
        }),
      });
    await expect(job).toContainText('Aguardando revisão', { timeout: 20000 });
    await expect(job).toContainText('Codex real NOT_VERIFIED');
    await expect(job).toContainText('limpeza confirmada');
    await job.getByText('Diff para revisão', { exact: true }).click();
    await expect(job).toContainText(
      '+<section class="hero"><h1>Bem-vindo à loja sintética</h1>',
    );
    await job
      .getByText('Testes reais e códigos de saída', { exact: true })
      .click();
    await expect(job).toContainText(
      'node --test tests/theme.test.mjs · saída 0',
    );
    await expect(job).toContainText('real sandbox denies');
    const view = await (await page.request.get('/api/delivery')).json();
    expect(view.jobs).toHaveLength(1);
    expect(view.jobs[0].result.harness).toBe('test-fixture');
    expect(view.jobs[0].result.cleanup_confirmed).toBe(true);
    await job
      .getByLabel('Decisão humana sobre o diff')
      .fill(
        'Diff, limites, base SHA e testes reais revisados; aceitar revisão sem integrar código.',
      );
    await job
      .getByRole('button', { name: 'Aceitar revisão', exact: true })
      .click();
    await expect(job).toContainText('Revisão aceita');
    await page.reload();
    await expect(job).toContainText('Revisão aceita');
    const snapshot = await (
      await page.request.get('/api/mission-control')
    ).json();
    expect(
      snapshot.requests.find((r: { id: string }) => r.id === governed.requestId)
        .status,
    ).toBe('ready');
    await page.screenshot({
      path: 'test-results/m5-agentic-delivery.png',
      fullPage: true,
    });
    expect(errors).toEqual([]);
  } finally {
    await Promise.all([adminContext.close(), poContext.close()]);
  }
});
