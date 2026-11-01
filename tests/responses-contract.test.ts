import { test, expect } from 'bun:test';
import { CappedGateway } from '../runner/src/gateway';
import { CodexAgent } from '../runner/src/codex-agent';
import {
  generateResponses,
  responsesRequest,
  responseChanges,
  boundedJson,
} from '../runner/src/responses';
import type { Transport } from '../runner/src/responses';
import type { DeliveryTask } from '../src/shared/delivery';
const master = 'm'.repeat(32);
export function syntheticTask(): DeliveryTask {
  const settings = {
    repo_key: 'synthetic',
    repository: 'https://github.com/synthetic/theme',
    base_branch: 'fixture-base',
    base_sha: 'a'.repeat(40),
    allowed_paths: ['templates/home.tpl'],
    task_types: ['nuvemshop-theme'] as 'nuvemshop-theme'[],
    harness: 'responses-api' as const,
    timeout_seconds: 5,
    max_input_tokens: 16000,
    max_output_tokens: 1024,
    input_micro_usd_per_million: '1000000',
    output_micro_usd_per_million: '2000000',
    job_budget_micro_usd: '100000',
    daily_budget_micro_usd: '1000000',
    total_budget_micro_usd: '10000000',
    daily_job_limit: 1,
    concurrency: 1,
    attempt_limit: 1 as const,
    min_margin_bps: 1000,
    report_max_age_minutes: 60,
    max_diff_bytes: 8192,
  };
  return {
    job_id: crypto.randomUUID(),
    spec_id: crypto.randomUUID(),
    request_id: crypto.randomUUID(),
    policy_version: 1,
    repo_key: settings.repo_key,
    repository: settings.repository,
    base_branch: settings.base_branch,
    base_sha: settings.base_sha,
    allowed_paths: settings.allowed_paths,
    specification: 'Corrigir título do tema sintético.',
    acceptance: 'Título Bem-vindo à loja sintética; preservar seção.',
    settings,
    basis_hash: 'synthetic',
  };
}
function output(t = syntheticTask()) {
  return {
    status: 'completed',
    output: [
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [
          {
            type: 'output_text',
            text: JSON.stringify({
              files: [
                {
                  path: t.allowed_paths[0],
                  content: '<h1>Bem-vindo à loja sintética</h1>',
                },
              ],
            }),
          },
        ],
      },
    ],
    usage: { input_tokens: 50, output_tokens: 40 },
  };
}
const request = (
  g: CappedGateway,
  path: string,
  token: string,
  body: unknown,
) =>
  g.handle(
    new Request('http://delivery-gateway:8080' + path, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token },
      body: JSON.stringify(body),
    }),
  );
test('Responses adapter and gateway enforce structured no-tools single request and fixed model', async () => {
  const t = syntheticTask();
  let calls = 0;
  const g = new CappedGateway(
    master,
    'test-key',
    'https://provider.test/v1/responses',
    'fixed',
    async (_u, i) => {
      calls++;
      const b = JSON.parse(String(i?.body));
      expect(b.tools).toEqual([]);
      expect(b.tool_choice).toBe('none');
      expect(b.text.format.type).toBe('json_schema');
      expect(b.model).toBe('fixed');
      expect(b.store).toBe(false);
      expect(b.stream).toBe(false);
      expect(b.max_output_tokens).toBe(1024);
      expect(i?.redirect).toBe('error');
      return Response.json(output(t));
    },
  );
  const l = await (await request(g, '/allocate', master, t)).json();
  const transport: Transport = async (u, i) =>
    g.handle(new Request(String(u), i));
  const changes = await generateResponses(
    t,
    { 'templates/home.tpl': '<h1>Loja</h1>' },
    l.url,
    l.token,
    'forged',
    AbortSignal.timeout(5000),
    transport,
  );
  expect(changes.files[0]?.path).toBe('templates/home.tpl');
  expect(changes.input_tokens).toBe(50);
  expect(calls).toBe(1);
  expect(
    (await request(g, '/v1/responses', l.token, responsesRequest(t, {}, 'x')))
      .status,
  ).toBe(429);
  expect((await request(g, '/allocate', master, t)).status).toBe(409);
  await new CodexAgent().generate().then(
    () => {
      throw Error('SDK enabled');
    },
    (e) => expect(e.code).toBe('unavailable'),
  );
});
test('gateway denies tool/state/unknown parameter bypasses before upstream', async () => {
  const t = syntheticTask();
  let calls = 0;
  const g = new CappedGateway(
    master,
    'test-key',
    'https://provider.test/v1/responses',
    'fixed',
    async () => {
      calls++;
      return Response.json(output(t));
    },
  );
  const l = await (await request(g, '/allocate', master, t)).json(),
    base = responsesRequest(t, {}, 'x');
  for (const change of [
    { tools: {} },
    { tools: [{ type: 'function', name: 'deploy' }] },
    { previous_response_id: 'prior' },
    { conversation: 'prior' },
    { background: true },
    { stream: true },
    { store: true },
    { include: ['x'] },
    { text: { format: { type: 'text' } } },
    { input: [{ type: 'function_call_output' }] },
  ])
    expect(
      (await request(g, '/v1/responses', l.token, { ...base, ...change }))
        .status,
    ).toBe(422);
  expect(calls).toBe(0);
  await request(g, '/close', master, { job_id: t.job_id });
  expect((await request(g, '/v1/responses', l.token, base)).status).toBe(429);
  for (const s of [
    { harness: 'codex-sdk' },
    { timeout_seconds: 0 },
    { input_micro_usd_per_million: '0' },
    { job_budget_micro_usd: '1' },
  ])
    expect(
      (
        await request(g, '/allocate', master, {
          ...t,
          job_id: crypto.randomUUID(),
          settings: { ...t.settings, ...s },
        })
      ).status,
    ).not.toBe(200);
});
test('refusal, incomplete, tools, paths, duplicate files, invalid schema and missing/invalid/excess usage fail closed', () => {
  const t = syntheticTask();
  const good = output(t);
  const bad = [
    { ...good, status: 'incomplete' },
    { ...good, error: {} },
    { ...good, output: [{ type: 'function_call' }] },
    { ...good, usage: null },
    { ...good, usage: { input_tokens: -1, output_tokens: 1 } },
    { ...good, usage: { input_tokens: '1', output_tokens: 1 } },
    { ...good, usage: { input_tokens: 32001, output_tokens: 1 } },
    { ...good, usage: { input_tokens: 1, output_tokens: 4097 } },
  ];
  for (const content of [
    [{ type: 'refusal', refusal: 'No' }],
    [{ type: 'output_text', text: 'truncated' }],
    [
      {
        type: 'output_text',
        text: JSON.stringify({ files: [{ path: '../escape', content: 'x' }] }),
      },
    ],
    [
      {
        type: 'output_text',
        text: JSON.stringify({
          files: [{ path: t.allowed_paths[0], content: 'x', extra: 'bad' }],
        }),
      },
    ],
    [
      {
        type: 'output_text',
        text: JSON.stringify({
          files: [
            { path: t.allowed_paths[0], content: 'x' },
            { path: t.allowed_paths[0], content: 'x' },
          ],
        }),
      },
    ],
  ])
    bad.push({ ...good, output: [{ ...good.output[0]!, content }] } as any);
  for (const v of bad) expect(() => responseChanges(v, t)).toThrow();
});
test('ambiguous upstream failure burns authorization; oversized response and cancellation have no retry', async () => {
  const t = syntheticTask();
  let calls = 0;
  const g = new CappedGateway(
    master,
    'test-key',
    'https://provider.test/v1/responses',
    'fixed',
    async () => {
      calls++;
      throw Error('private provider failure');
    },
  );
  const l = await (await request(g, '/allocate', master, t)).json();
  const r = await request(
    g,
    '/v1/responses',
    l.token,
    responsesRequest(t, {}, 'x'),
  );
  expect(r.status).toBe(502);
  expect(await r.text()).not.toContain('private');
  expect(
    (await request(g, '/v1/responses', l.token, responsesRequest(t, {}, 'x')))
      .status,
  ).toBe(429);
  expect(calls).toBe(1);
  await expect(
    boundedJson(new Response('x'.repeat(64001)), 64000),
  ).rejects.toThrow();
  const abort = new AbortController();
  abort.abort();
  await expect(
    generateResponses(t, {}, l.url, l.token, 'x', abort.signal, async () => {
      calls++;
      return Response.json(output(t));
    }),
  ).rejects.toThrow();
  expect(calls).toBe(1);
  const deadline = AbortSignal.timeout(20);
  await expect(
    generateResponses(
      t,
      {},
      l.url,
      l.token,
      'x',
      deadline,
      async (_u, i) =>
        new Promise((_r, reject) =>
          i?.signal?.addEventListener('abort', () => reject(Error('timeout'))),
        ),
    ),
  ).rejects.toThrow();
});
