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

test('Google Workspace homologation profile is validated offline without real credentials', async () => {
  const { validateGoogleProfile } =
    await import('../src/server/google-profile');
  const example = loadConfig({
    APP_ORIGIN: 'https://localhost:3443',
    OIDC_ISSUER: 'https://accounts.google.com',
    OIDC_CLIENT_ID: 'fake-test.apps.googleusercontent.com',
    OIDC_CLIENT_SECRET: 'test-only-not-real',
    OIDC_HOSTED_DOMAIN: 'catus.example',
  });
  expect(validateGoogleProfile(example)).toEqual({
    redirectUri: 'https://localhost:3443/api/auth/callback',
    issuer: 'https://accounts.google.com',
    hostedDomain: 'catus.example',
  });
  expect(() =>
    validateGoogleProfile({ ...example, secureCookies: false }),
  ).toThrow();
  expect(() =>
    validateGoogleProfile({
      ...example,
      oidc: { ...example.oidc!, hostedDomain: undefined },
    }),
  ).toThrow();
  expect(() =>
    validateGoogleProfile({
      ...example,
      oidc: { ...example.oidc!, issuer: 'https://evil.example' },
    }),
  ).toThrow();
});

test('runtime launcher strips privileged database and backup credentials from the serving process', async () => {
  const child = Bun.spawn(
    [
      'node',
      '--input-type=module',
      '-e',
      `import {runtimeEnvironment} from './scripts/runtime.mjs';const env=runtimeEnvironment({DATABASE_URL:'admin',MIGRATION_DATABASE_URL:'migration',MAINTENANCE_DATABASE_URL:'maintenance',BACKUP_KEY_FILE:'key'}, {APP_ORIGIN:'https://localhost:3443'}, {RUNTIME_DATABASE_URL:'runtime'});console.log(JSON.stringify(env));`,
    ],
    { stdout: 'pipe' },
  );
  const env = JSON.parse(await new Response(child.stdout).text());
  expect(await child.exited).toBe(0);
  expect(env).toEqual({
    APP_ORIGIN: 'https://localhost:3443',
    RUNTIME_DATABASE_URL: 'runtime',
  });
});
