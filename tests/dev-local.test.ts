import { describe, expect, test } from 'bun:test';
import {
  DevLocalError,
  assertLocalDatabaseUrl,
  cleanChildEnvironment,
  holderFromSs,
  parsePostmaster,
  portConflictMessage,
  validateDevEnvironment,
  // @ts-expect-error plain script without declarations
} from '../scripts/lib/dev-local.mjs';

const GOOD = {
  DATABASE_URL: 'postgres://catus:catus_local_only@127.0.0.1:5432/catus',
  APP_ORIGIN: 'http://127.0.0.1:5173',
  PORT: '3000',
};
describe('dev:local never leaves this machine', () => {
  for (const url of [
    'postgres://u:p@db.exemplo.com/catus',
    'postgres://u:p@10.0.0.5:5432/catus',
    'postgres://u:p@catus-db/catus',
    'postgres://u:p@127.0.0.1.exemplo.com/catus',
    'postgres://u:p@localhost.exemplo.com/catus',
  ])
    test(`refuses ${url}`, () => {
      expect(() => assertLocalDatabaseUrl('X', url)).toThrow(DevLocalError);
    });
  test('refuses another local database and a broken URL', () => {
    expect(() =>
      assertLocalDatabaseUrl('X', 'postgres://u:p@127.0.0.1/producao'),
    ).toThrow('producao');
    expect(() => assertLocalDatabaseUrl('X', 'nao-e-url')).toThrow(
      DevLocalError,
    );
  });
  test('accepts the local databases', () => {
    assertLocalDatabaseUrl('X', 'postgres://u:p@127.0.0.1:5432/catus');
    assertLocalDatabaseUrl('X', 'postgres://u:p@localhost/catus_test');
  });
  test('checks every source, and any database variable', () => {
    expect(() =>
      validateDevEnvironment([
        GOOD,
        { RUNTIME_DATABASE_URL: 'postgres://u:p@remoto/catus' },
      ]),
    ).toThrow('RUNTIME_DATABASE_URL');
    expect(() =>
      validateDevEnvironment([
        GOOD,
        { ANY_DATABASE_URL: 'postgres://u:p@remoto/catus' },
      ]),
    ).toThrow('ANY_DATABASE_URL');
  });
  test('child processes do not inherit database credentials from the shell', () => {
    const env = cleanChildEnvironment({
      PATH: '/bin',
      DATABASE_URL: 'x',
      RUNTIME_DATABASE_URL: 'x',
      PGPASSWORD: 'x',
      PGHOST: 'x',
    });
    expect(env).toEqual({ PATH: '/bin' });
  });
});
describe('dev:local settings', () => {
  test('accepts the defaults and reports login state', () => {
    expect(validateDevEnvironment([GOOD]).oidc).toBe(false);
    expect(
      validateDevEnvironment([
        GOOD,
        {
          OIDC_ISSUER: 'https://accounts.google.com',
          OIDC_CLIENT_ID: 'a',
          OIDC_CLIENT_SECRET: 'b',
        },
      ]).oidc,
    ).toBe(true);
  });
  test('refuses what would break the proxy, cookies or login, with a reason', () => {
    for (const [extra, expected] of [
      [{ NODE_ENV: 'production' }, 'NODE_ENV'],
      [{ APP_ORIGIN: 'https://catus.exemplo.com' }, 'APP_ORIGIN'],
      [{ APP_ORIGIN: 'http://127.0.0.1:4000' }, 'APP_ORIGIN'],
      [{ PORT: '3443' }, 'PORT'],
      [{ TLS_CERT_FILE: 'x' }, 'TLS_CERT_FILE'],
      [{ OIDC_CLIENT_ID: 'só um' }, 'OIDC incompleto'],
    ] as const)
      expect(() => validateDevEnvironment([GOOD, extra])).toThrow(expected);
  });
});
describe('dev:local messages', () => {
  test('names who holds a port and what to do', () => {
    const holder = holderFromSs(
      'LISTEN 0 512 127.0.0.1:3000 0.0.0.0:* users:(("bun",pid=4242,fd=12))',
    );
    expect(holder).toEqual({ name: 'bun', pid: 4242 });
    const text = portConflictMessage(3000, 'a API', holder);
    expect(text).toContain('A porta 3000');
    expect(text).toContain('bun (pid 4242)');
    expect(text).toContain('kill 4242');
  });
  test('works when the system does not say who it is', () => {
    expect(
      holderFromSs('LISTEN 0 512 127.0.0.1:3000 0.0.0.0:*'),
    ).toBeUndefined();
    expect(portConflictMessage(5173, 'o Vite', undefined)).toContain(
      "ss -ltnp 'sport = :5173'",
    );
  });
  test('reads a postmaster.pid', () => {
    expect(
      parsePostmaster('123\n/x/.local/postgres\n1700000000\n5432\n/tmp\n'),
    ).toEqual({ pid: 123, dataDir: '/x/.local/postgres', port: 5432 });
    expect(parsePostmaster('')).toBeUndefined();
  });
});
