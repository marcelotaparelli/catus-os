import { expect, test } from 'bun:test';
import { loadConfig } from '../src/server/config';
import { cookie } from '../src/server/auth/cookies';
test('OIDC configuration fails closed, HTTPS and secure cookie prefix are enforced', () => {
  expect(loadConfig({}).oidc).toBeUndefined();
  expect(() =>
    loadConfig({ OIDC_ISSUER: 'https://accounts.google.com' }),
  ).toThrow();
  expect(() => loadConfig({ APP_ORIGIN: 'http://example.com' })).toThrow();
  expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow();
  expect(() => loadConfig({ APP_ORIGIN: 'https://app.test/path' })).toThrow();
  expect(() =>
    loadConfig({
      OIDC_ISSUER: 'http://issuer.test',
      OIDC_CLIENT_ID: 'test',
      OIDC_CLIENT_SECRET: 'test',
    }),
  ).toThrow();
  const c = loadConfig({ APP_ORIGIN: 'https://app.test' });
  expect(cookie(c, 'session', 'example', 100)).toBe(
    '__Host-catus_session=example; Path=/; HttpOnly; SameSite=Lax; Max-Age=100; Secure',
  );
});
