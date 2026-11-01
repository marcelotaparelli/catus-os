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
