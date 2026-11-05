import { describe, expect, test } from 'bun:test';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DevLocalError,
  assertLocalDatabaseUrl,
  cleanChildEnvironment,
  holderFromSs,
  hydrateEmbeddedPostgres,
  parsePostmaster,
  PORT_RANGES,
  chooseFreePort,
  databaseUrlAt,
  isOwnProcess,
  roleFileAtPort,
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
      [{ APP_ORIGIN: 'http://0.0.0.0:5173' }, 'APP_ORIGIN'],
      [{ APP_ORIGIN: 'http://127.0.0.1:80' }, 'APP_ORIGIN'],
      [{ PORT: '80' }, 'PORT'],
      [{ PORT: 'abc' }, 'PORT'],
      [{ TLS_CERT_FILE: 'x' }, 'TLS_CERT_FILE'],
      [{ OIDC_CLIENT_ID: 'só um' }, 'OIDC incompleto'],
    ] as const)
      expect(() => validateDevEnvironment([GOOD, extra])).toThrow(expected);
  });
});
describe('dev:local ports', () => {
  test('keeps the usual port when free, and takes the next free one when not', async () => {
    const busy = new Set([3000, 3001]);
    const free = async (p: number) => !busy.has(p);
    expect(await chooseFreePort([3000], PORT_RANGES.api, free)).toBe(3002);
    expect(await chooseFreePort([3100], PORT_RANGES.api, free)).toBe(3100);
  });
  test('tries the preferred ports first, in order, before the range', async () => {
    const tried: number[] = [];
    const port = await chooseFreePort(
      [5432, 5440],
      PORT_RANGES.db,
      async (p: number) => {
        tried.push(p);
        return p === 5440;
      },
    );
    expect(port).toBe(5440);
    expect(tried).toEqual([5432, 5440]);
  });
  test('says so when nothing is free', async () => {
    await expect(
      chooseFreePort([3000], [3001, 3002], async () => false),
    ).rejects.toThrow('Nenhuma porta livre entre 3001 e 3002');
  });
  test('the ranges do not overlap and stay out of privileged ports', () => {
    const ranges = Object.values(PORT_RANGES) as [number, number][];
    for (const [a, b] of ranges) {
      expect(a).toBeGreaterThan(1023);
      for (const [c, d] of ranges)
        if (a !== c) expect(b < c || d < a).toBe(true);
    }
  });
  test('moves a role file to another port, keeping credentials and other lines', () => {
    const text =
      'RUNTIME_DATABASE_URL=postgres://catus_runtime:abc@127.0.0.1:5432/catus\nDB_RUNTIME_ROLE=catus_runtime\n';
    const moved = roleFileAtPort(text, 5433);
    expect(moved).toContain(
      'postgres://catus_runtime:abc@127.0.0.1:5433/catus',
    );
    expect(moved).toContain('DB_RUNTIME_ROLE=catus_runtime');
    expect(roleFileAtPort(moved, 5432)).toBe(text);
    expect(databaseUrlAt('postgres://a:b@127.0.0.1:5432/catus', 5450)).toBe(
      'postgres://a:b@127.0.0.1:5450/catus',
    );
  });
});
describe('dev:local only touches its own processes', () => {
  const here = '/home/dev/catus';
  test('recognizes its programs running from this checkout', () => {
    for (const cmdline of [
      'node scripts/dev-local.mjs',
      'node scripts/postgres.mjs',
      'bun --no-env-file --watch src/server/index.ts',
      '/usr/bin/node /home/dev/catus/node_modules/.bin/vite --host 127.0.0.1',
    ])
      expect(isOwnProcess({ cwd: here, cmdline }, here)).toBe(true);
  });
  test('never claims a VM, another checkout or a reused pid', () => {
    expect(
      isOwnProcess({ cwd: here, cmdline: 'libkrun --vm agent' }, here),
    ).toBe(false);
    expect(
      isOwnProcess(
        { cwd: '/home/dev/outro', cmdline: 'node scripts/dev-local.mjs' },
        here,
      ),
    ).toBe(false);
    expect(isOwnProcess({ cwd: here, cmdline: 'vim notas.txt' }, here)).toBe(
      false,
    );
  });
});
describe('dev:local messages', () => {
  test('reads who holds a port, when the system says', () => {
    expect(
      holderFromSs(
        'LISTEN 0 512 127.0.0.1:3000 0.0.0.0:* users:(("libkrun",pid=3327,fd=12))',
      ),
    ).toEqual({ name: 'libkrun', pid: 3327 });
    expect(
      holderFromSs('LISTEN 0 512 127.0.0.1:3000 0.0.0.0:*'),
    ).toBeUndefined();
  });
  test('reads a postmaster.pid', () => {
    expect(
      parsePostmaster('123\n/x/.local/postgres\n1700000000\n5432\n/tmp\n'),
    ).toEqual({ pid: 123, dataDir: '/x/.local/postgres', port: 5432 });
    expect(parsePostmaster('')).toBeUndefined();
  });
});
test('only the three reviewed packages may run install scripts', async () => {
  const pkg = await Bun.file('package.json').json();
  expect(pkg.trustedDependencies).toEqual([
    '@embedded-postgres/linux-x64',
    'bun',
    'esbuild',
  ]);
});
describe('embedded PostgreSQL library links', () => {
  function fixture(list: { source: string; target: string }[]) {
    const dir = mkdtempSync(join(tmpdir(), 'catus-pg-links-'));
    mkdirSync(join(dir, 'native/lib'), { recursive: true });
    writeFileSync(join(dir, 'native/lib/libx.so.6.18'), 'x');
    writeFileSync(join(dir, 'native/pg-symlinks.json'), JSON.stringify(list));
    return dir;
  }
  test('creates relative links once, and repeating changes nothing', () => {
    const dir = fixture([
      { source: 'native/lib/libx.so.6.18', target: 'native/lib/libx.so.6' },
      { source: 'native/lib/libx.so.6.18', target: 'native/lib/libx.so' },
    ]);
    expect(hydrateEmbeddedPostgres(dir)).toBe(2);
    expect(readlinkSync(join(dir, 'native/lib/libx.so.6'))).toBe(
      'libx.so.6.18',
    );
    expect(hydrateEmbeddedPostgres(dir)).toBe(0);
  });
  test('leaves an existing file alone', () => {
    const dir = fixture([
      { source: 'native/lib/libx.so.6.18', target: 'native/lib/libx.so.6' },
    ]);
    writeFileSync(join(dir, 'native/lib/libx.so.6'), 'real');
    expect(hydrateEmbeddedPostgres(dir)).toBe(0);
    expect(lstatSync(join(dir, 'native/lib/libx.so.6')).isSymbolicLink()).toBe(
      false,
    );
  });
  test('refuses a list pointing outside the package', () => {
    for (const entry of [
      { source: 'native/lib/libx.so.6.18', target: '../../fora' },
      { source: '../../../etc/passwd', target: 'native/lib/y' },
    ])
      expect(() => hydrateEmbeddedPostgres(fixture([entry]))).toThrow(
        'fora do pacote',
      );
  });
});
