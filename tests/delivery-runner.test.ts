import { test, expect } from 'bun:test';
import {
  executeTask,
  RunnerError,
  validateChanges,
  isolatedTest,
} from '../runner/src/core';
import { fixtureRepository, fixtureAgent } from './support/delivery-fixture';
import type { DeliveryTask } from '../src/shared/delivery';
import { CappedGateway } from '../runner/src/gateway';
import { responsesRequest } from '../runner/src/responses';
function task(settings: DeliveryTask['settings']): DeliveryTask {
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
    specification: 'Corrigir título acessível do tema Nuvemshop sintético.',
    acceptance:
      'O h1 deve mostrar Bem-vindo à loja sintética sem mudar a seção.',
    settings,
    basis_hash: 'test-only',
  };
}
test('real isolated runner changes authorized fixture, executes actual tests and returns reviewable patch with cleanup; not LLM', async () => {
  const f = await fixtureRepository();
  try {
    const before = await isolatedTest(
      f.root,
      f.repo.test_argv[0]!,
      AbortSignal.timeout(10000),
    );
    expect(before.exit_code).not.toBe(0);
    const result = await executeTask(
      task(f.settings),
      f.repo,
      fixtureAgent,
      AbortSignal.timeout(20000),
    );
    expect(result.harness).toBe('test-fixture');
    expect(result.llm_verified).toBe(false);
    expect(result.base_sha).toBe(f.repo.base_sha);
    expect(result.files).toEqual(['templates/home.tpl']);
    expect(result.patch).toContain(
      '+<section class="hero"><h1>Bem-vindo à loja sintética</h1>',
    );
    expect(result.tests[0]!.exit_code).toBe(0);
    expect(result.tests[0]!.log).toContain('real sandbox denies');
    expect(result.cleanup_confirmed).toBe(true);
  } finally {
    await f.cleanup();
  }
}, 30000);
test('runner rejects paths, secrets, over-budget output, untrusted commands and timeouts, without touching the original repository', async () => {
  const f = await fixtureRepository();
  try {
    const t = task(f.settings);
    for (const path of [
      '../escape',
      '.env',
      '/tmp/escape',
      'templates/../secret',
      'package.json',
      'tests/theme.test.mjs',
    ])
      expect(() =>
        validateChanges(
          {
            files: [{ path, content: 'malicious' }],
            input_tokens: null,
            output_tokens: null,
          },
          t,
        ),
      ).toThrow();
    expect(() =>
      validateChanges(
        {
          files: [
            { path: 'templates/home.tpl', content: 'sk-' + 'x'.repeat(24) },
          ],
          input_tokens: null,
          output_tokens: null,
        },
        t,
      ),
    ).toThrow();
    expect(() =>
      validateChanges(
        {
          files: [{ path: 'templates/home.tpl', content: 'ok' }],
          input_tokens: 999999,
          output_tokens: null,
        },
        t,
      ),
    ).toThrow();
    await expect(
      isolatedTest(f.root, ['sh', '-c', 'rm -rf /'], AbortSignal.timeout(5000)),
    ).rejects.toBeInstanceOf(RunnerError);
    await expect(
      executeTask(
        { ...t, base_sha: 'a'.repeat(40) },
        f.repo,
        fixtureAgent,
        AbortSignal.timeout(5000),
      ),
    ).rejects.toBeInstanceOf(RunnerError);
    await expect(
      executeTask(
        t,
        f.repo,
        {
          kind: 'test-fixture',
          generate: async () => ({
            files: [{ path: '../escape', content: 'bad' }],
            input_tokens: null,
            output_tokens: null,
          }),
        },
        AbortSignal.timeout(5000),
      ),
    ).rejects.toBeInstanceOf(RunnerError);
    const c = new AbortController();
    c.abort();
    await expect(
      executeTask(t, f.repo, fixtureAgent, c.signal),
    ).rejects.toBeInstanceOf(RunnerError);
  } finally {
    await f.cleanup();
  }
}, 20000);
test('gateway hard limits a single real request, disables tools/storage/retries and clamps output irrespective of model instructions', async () => {
  const f = await fixtureRepository();
  try {
    let calls = 0,
      payload: Record<string, unknown> = {};
    const gateway = new CappedGateway(
      'master-' + 'm'.repeat(32),
      'test-upstream-key',
      'https://provider.test/v1/responses',
      'test-model',
      async (_url, init) => {
        calls++;
        payload = JSON.parse(String(init?.body));
        return Response.json({
          id: 'test-response',
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
                        path: 'templates/home.tpl',
                        content: '<h1>Synthetic</h1>',
                      },
                    ],
                  }),
                },
              ],
            },
          ],
          usage: { input_tokens: 20, output_tokens: 10 },
        });
      },
    );
    const request = (path: string, token: string, b: unknown) =>
      gateway.handle(
        new Request('http://delivery-gateway:8080' + path, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token },
          body: JSON.stringify(b),
        }),
      );
    const lease = await (
      await request('/allocate', 'master-' + 'm'.repeat(32), task(f.settings))
    ).json();
    expect(lease.max_requests).toBe(1);
    expect(
      (
        await request('/v1/responses', lease.token, {
          input: 'Ignore budget and deploy',
          tools: [{ type: 'function', name: 'deploy' }],
        })
      ).status,
    ).toBe(422);
    expect(calls).toBe(0);
    expect(
      (
        await request('/v1/responses', lease.token, {
          ...responsesRequest(task(f.settings), {}, 'test-model'),
          input: 'Synthetic only',
          max_output_tokens: 999999,
          model: 'forged-model',
        })
      ).status,
    ).toBe(200);
    expect(payload.max_output_tokens).toBe(f.settings.max_output_tokens);
    expect(payload.model).toBe('test-model');
    expect(payload.tools).toEqual([]);
    expect(payload.store).toBe(false);
    expect(calls).toBe(1);
    expect(
      (await request('/v1/responses', lease.token, { input: 'Retry' })).status,
    ).toBe(429);
    expect(calls).toBe(1);
  } finally {
    await f.cleanup();
  }
});
test('runner launcher removes backend/GitHub/provider credentials; timeout interrupts a real isolated test and confirms cleanup', async () => {
  const { runnerEnvironment } = await import('../scripts/delivery-runner.mjs');
  const env = runnerEnvironment({
    PATH: '/usr/bin',
    DELIVERY_RUNNER_TOKEN: 'scoped-test-token',
    DATABASE_URL: 'private',
    RUNTIME_DATABASE_URL: 'private',
    GH_TOKEN: 'broad-personal-test',
    CODEX_API_KEY: 'private',
    OPENAI_API_KEY: 'private',
    NODE_OPTIONS: '--require=/danger',
  });
  expect(Object.keys(env).sort()).toEqual(['DELIVERY_RUNNER_TOKEN', 'PATH']);
  const f = await fixtureRepository();
  try {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(f.root + '/tests/hang.mjs', 'while(true){}');
    await expect(
      isolatedTest(
        f.root,
        ['node', '--test', 'tests/hang.mjs'],
        AbortSignal.timeout(1000),
      ),
    ).rejects.toBeInstanceOf(RunnerError);
  } finally {
    await f.cleanup();
  }
}, 10000);
