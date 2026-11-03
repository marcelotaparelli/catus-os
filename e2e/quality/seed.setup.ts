/**
 * Deterministic synthetic data for the quality suite. Runs once per
 * `npm run test:quality` against the disposable test database recreated by
 * tests/support/browser-server.ts. Uses only the public API with real sessions.
 */
import { test as setup, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { login } from '../login';
import { ROLES } from './fixtures';

async function session(browser: Browser, email: string) {
  const page = await (await browser.newContext()).newPage();
  await login(page, email);
  return page;
}
async function call<T = Record<string, unknown>>(
  page: Page,
  path: string,
  method: string,
  body?: unknown,
): Promise<T> {
  return page.evaluate(
    async ({ path, method, body }) => {
      const s = await (await fetch('/api/session')).json();
      const r = await fetch('/api/' + path, {
        method,
        headers: {
          'X-CSRF-Token': s.csrfToken,
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok)
        throw new Error(
          `${method} ${path}: ${r.status} ${JSON.stringify(json)}`,
        );
      return json;
    },
    { path, method, body },
  );
}

setup('seed synthetic M0–M3 data', async ({ browser }) => {
  setup.setTimeout(60000);
  const admin = await session(browser, ROLES.administrator);
  const po = await session(browser, ROLES.po);
  const manager = await session(browser, ROLES.manager);
  await call(admin, 'commercial/policy', 'POST', {
    version: 0,
    approval_roles: ['manager', 'administrator'],
  });
  const members = await call<{ id: string; name: string }[]>(
    po,
    'members',
    'GET',
  );
  const dev = members.find((m) => m.name === 'Dev Browser')!.id;
  const client = await call<{ id: string }>(po, 'clients', 'POST', {
    name: 'Aurora Varejo (sintético)',
  });
  const project = await call<{ id: string }>(po, 'projects', 'POST', {
    client_id: client.id,
    name: 'Portal B2B',
  });
  const interaction = await call<{ id: string }>(po, 'interactions', 'POST', {
    project_id: project.id,
    kind: 'meeting',
    summary:
      'Reunião sintética: checkout com cupom de desconto; frete expresso fica fora do escopo inicial.',
    occurred_at: '2026-10-15T14:00:00Z',
  });
  const request = await call<{ id: string; version: number }>(
    po,
    'requests',
    'POST',
    {
      interaction_id: interaction.id,
      title: 'Checkout com cupom',
      description: 'Aplicar cupom percentual no checkout do portal B2B.',
      next_action: 'Detalhar regras de cupom com o cliente',
      owner_user_id: dev,
    },
  );
  await call(po, 'requests', 'POST', {
    interaction_id: interaction.id,
    title: 'Relatório de pedidos',
    description: 'Exportar pedidos do mês em CSV.',
    next_action: 'Validar colunas obrigatórias',
    owner_user_id: dev,
  });
  const contract = await call<{ id: string; version: number }>(
    po,
    'contracts',
    'POST',
    {
      project_id: project.id,
      client_id: client.id,
      title: 'Contrato Portal B2B 2026',
      kind: 'fixed_price',
      currency: 'BRL',
      valid_from: '2026-01-01',
      valid_until: '2026-12-31',
      document_reference: 'SYNTHETIC-DOC-2026-001',
    },
  );
  await call(manager, `contracts/${contract.id}`, 'PATCH', {
    version: contract.version,
    state: 'active',
  });
  const scope = await call<{ id: string; version: number }>(
    po,
    'scopes',
    'POST',
    {
      project_id: project.id,
      contract_id: contract.id,
      title: 'Escopo inicial do portal',
      items: [
        {
          description: 'Checkout com cupom percentual',
          deliverables: 'Fluxo de checkout com campo de cupom',
          exclusions: 'Frete expresso e meios de pagamento externos',
          acceptance_criteria:
            'Pedido sintético finalizado com desconto aplicado',
          dependencies: 'Layout aprovado pelo cliente',
          origin_interaction_id: interaction.id,
          origin_request_id: null,
        },
      ],
    },
  );
  const submitted = await call<{ version: number }>(
    po,
    `scopes/${scope.id}/submit`,
    'POST',
    {
      version: scope.version,
    },
  );
  const approved = await call<{ items: { id: string }[] }>(
    manager,
    `scopes/${scope.id}/decide`,
    'POST',
    {
      version: submitted.version,
      decision: 'approved',
      reason: 'Escopo conforme contrato sintético.',
    },
  );
  const item =
    approved.items?.[0]?.id ??
    (
      await call<{ scopes: { id: string; items: { id: string }[] }[] }>(
        po,
        'commercial',
        'GET',
      )
    ).scopes.find((s) => s.id === scope.id)!.items[0]!.id;
  await call(po, `requests/${request.id}/coverage`, 'POST', {
    version: request.version,
    scope_item_id: item,
  });
  const view = await call<{ contracts: unknown[]; scopes: unknown[] }>(
    po,
    'commercial',
    'GET',
  );
  expect([view.contracts.length, view.scopes.length]).toEqual([1, 1]);
});
