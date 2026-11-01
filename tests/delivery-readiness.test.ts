import { test, expect } from 'bun:test';
import { readiness } from '../runner/src/readiness';
test('offline readiness denies absent boundaries without secrets or claiming inference', async () => {
  const result = await readiness({ PATH: '/nonexistent' });
  expect(result.real_inference).toBe('NOT_VERIFIED');
  expect(result.boundaries).toHaveLength(10);
  expect(
    result.boundaries.every((b) =>
      ['DENIED', 'NOT_VERIFIED'].includes(b.status),
    ),
  ).toBe(true);
  const secret = 'DO_NOT_PRINT_THIS_VALUE';
  const configured = await readiness({
    PATH: '/nonexistent',
    CODEX_UPSTREAM_KEY: secret,
    CODEX_MODEL: secret,
  });
  expect(JSON.stringify(configured)).not.toContain(secret);
  expect(configured.boundaries[0]?.status).toBe('CONFIGURED_NOT_VERIFIED');
  expect(configured.real_inference).toBe('NOT_VERIFIED');
});

test('legacy attestation cannot enable the separate Responses adapter', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { deliveryConfig } = await import('../src/server/delivery/config');
  const dir = await mkdtemp(join(tmpdir(), 'catus-readiness-'));
  try {
    const file = join(dir, 'repos.json');
    await writeFile(
      file,
      JSON.stringify([
        {
          key: 'synthetic',
          repository: 'https://github.com/synthetic/theme',
          base_branch: 'fixture-base',
          base_sha: 'a'.repeat(40),
          allowed_paths: ['templates/home.tpl'],
        },
      ]),
    );
    const env = {
      DELIVERY_ENABLED: 'true',
      DELIVERY_REPOSITORIES_FILE: file,
      DELIVERY_RUNNER_ATTESTATION: 'isolated-sdk-capped-gateway-v1',
    };
    expect(deliveryConfig(env).available).toBe(false);
    expect(
      deliveryConfig({
        ...env,
        DELIVERY_RUNNER_ATTESTATION: 'isolated-responses-capped-gateway-v1',
      }).available,
    ).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
