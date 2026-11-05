// Credential file read as data, the managed .env keys, the worker launcher and the guards of
// the assisted homologation. No database and no network.
import { afterAll, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  checkSecretFile,
  readSecretFile,
} from '../scripts/lib/secret-file.mjs';
import { upsertEnv } from '../scripts/lib/clickup-homolog.mjs';
import {
  clickupWorkerEnvironment,
  runtimeEnvironment,
  workerEnvironment,
} from '../scripts/runtime.mjs';

const root = mkdtempSync(join(tmpdir(), 'catus-secret-'));
chmodSync(root, 0o700);
afterAll(() => rmSync(root, { recursive: true, force: true }));
const TOKEN = 'pk_1234567_SYNTHETICNOTREAL';
const secret = (name: string, content = TOKEN + '\n', mode = 0o600) => {
  const dir = join(root, name);
  mkdirSync(dir, { mode: 0o700 });
  const file = join(dir, 'token');
  writeFileSync(file, content, { mode });
  chmodSync(file, mode);
  return file;
};
const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(String((e as Error).message)).not.toContain(TOKEN);
    return (e as { rule?: string }).rule ?? 'other';
  }
  return 'accepted';
};

test('a token file is read as data, never executed, and only when nobody else can touch it', () => {
  expect(readSecretFile(secret('ok'))).toBe(TOKEN);
  expect(readSecretFile(secret('crlf', TOKEN + '\r\n'))).toBe(TOKEN);
  expect(refusal(() => readSecretFile(secret('open', TOKEN, 0o644)))).toBe(
    'permissões abertas; use chmod 600',
  );
  const shared = secret('shared');
  chmodSync(join(root, 'shared'), 0o777);
  expect(refusal(() => readSecretFile(shared))).toBe(
    'diretório gravável por outros',
  );
  const link = join(root, 'ok', 'link');
  symlinkSync(join(root, 'ok', 'token'), link);
  expect(refusal(() => readSecretFile(link))).toBe('link simbólico');
  expect(refusal(() => readSecretFile(join(root, 'none')))).toBe(
    'arquivo inexistente',
  );
  expect(refusal(() => readSecretFile('relative/token'))).toBe(
    'caminho absoluto obrigatório',
  );
  expect(refusal(() => readSecretFile(join(root, 'ok')))).toBe(
    'não é um arquivo comum',
  );
  // Shell syntax is just a malformed value: nothing is evaluated.
  const marker = join(root, 'executed');
  for (const [name, content] of [
    ['shell', `CLICKUP_API_TOKEN=${TOKEN}; touch ${marker}\n`],
    ['subst', `$(touch ${marker})\n`],
    ['two', `${TOKEN}\n${TOKEN}\n`],
    ['empty', '\n'],
  ] as const)
    expect(refusal(() => readSecretFile(secret(name, content)))).toBe(
      'conteúdo fora do formato esperado',
    );
  expect(existsSync(marker)).toBe(false);
  expect(
    refusal(() =>
      readSecretFile(secret('mine'), { uid: (process.getuid?.() ?? 0) + 1 }),
    ),
  ).toBe('dono diferente do usuário atual');
  expect(
    refusal(() => checkSecretFile(secret('repo'), { repository: root })),
  ).toBe('dentro do repositório');
});

test('the worker launcher turns the file into the token for the worker only', () => {
  const file = secret('launcher');
  const env = clickupWorkerEnvironment(
    { CLICKUP_API_TOKEN_FILE: file, OIDC_CLIENT_SECRET: 'x' },
    {},
    { CLICKUP_WORKER_DATABASE_URL: 'postgres://worker' },
  );
  expect(env.CLICKUP_API_TOKEN).toBe(TOKEN);
  expect(env.CLICKUP_API_TOKEN_FILE).toBeUndefined();
  expect(env.OIDC_CLIENT_SECRET).toBeUndefined();
  expect(() =>
    clickupWorkerEnvironment(
      { CLICKUP_API_TOKEN_FILE: file, CLICKUP_API_TOKEN: TOKEN },
      {},
      { CLICKUP_WORKER_DATABASE_URL: 'postgres://worker' },
    ),
  ).toThrow('not both');
  expect(() =>
    clickupWorkerEnvironment(
      { CLICKUP_API_TOKEN_FILE: secret('loose', TOKEN, 0o640) },
      {},
      { CLICKUP_WORKER_DATABASE_URL: 'postgres://worker' },
    ),
  ).toThrow('permissões abertas');
  // Web and AI worker never learn the token nor where it lives.
  for (const other of [
    runtimeEnvironment(
      { CLICKUP_API_TOKEN_FILE: file, CLICKUP_API_TOKEN: TOKEN },
      {},
      { RUNTIME_DATABASE_URL: 'postgres://runtime' },
    ),
    workerEnvironment(
      { CLICKUP_API_TOKEN_FILE: file, CLICKUP_API_TOKEN: TOKEN },
      {},
      { AI_WORKER_DATABASE_URL: 'postgres://ai' },
    ),
  ]) {
    expect(other.CLICKUP_API_TOKEN).toBeUndefined();
    expect(other.CLICKUP_API_TOKEN_FILE).toBeUndefined();
  }
});

test('the flow edits only its own non-secret .env keys and keeps everything else', () => {
  const before =
    '# comentário\nOIDC_CLIENT_SECRET=s3cr3t\nCLICKUP_ENABLED=false\nAPP_ORIGIN=http://127.0.0.1:5173\n';
  const after = upsertEnv(before, {
    CLICKUP_ENABLED: 'true',
    CLICKUP_WORKSPACE_ID: '1234567',
  });
  expect(after).toBe(
    '# comentário\nOIDC_CLIENT_SECRET=s3cr3t\nCLICKUP_ENABLED=true\nAPP_ORIGIN=http://127.0.0.1:5173\nCLICKUP_WORKSPACE_ID=1234567\n',
  );
  expect(upsertEnv(after, { CLICKUP_ENABLED: 'true' })).toBe(after);
  for (const key of ['OIDC_CLIENT_SECRET', 'CLICKUP_API_TOKEN', 'DATABASE_URL'])
    expect(() => upsertEnv(before, { [key]: 'x' })).toThrow('não gerenciada');
});

const flow = (cwd: string, ...args: string[]) => {
  const p = Bun.spawnSync(
    [
      resolve('node_modules/.bin/bun'),
      '--no-env-file',
      resolve('scripts/clickup-homolog.ts'),
      ...args,
    ],
    { cwd, env: { PATH: process.env.PATH!, HOME: root } },
  );
  return {
    code: p.exitCode,
    out: p.stdout.toString() + p.stderr.toString(),
  };
};
const clone = (name: string) => {
  const dir = join(root, name);
  mkdirSync(dir);
  Bun.spawnSync(['git', 'init', '-q', dir]);
  return dir;
};

test('init marks only a fresh clone; an installation in use is refused untouched', () => {
  for (const existing of ['.local', '.env']) {
    const dir = clone('used' + existing);
    if (existing === '.local') mkdirSync(join(dir, '.local'));
    else writeFileSync(join(dir, '.env'), 'APP_ORIGIN=x\n');
    const r = flow(dir, 'init');
    expect(r.code).toBe(1);
    expect(r.out.trim()).toStartWith(
      'Recusado: este diretório já tem .local ou .env',
    );
    expect(r.out.trim()).toEndWith('Nada foi alterado.');
    expect(existsSync(join(dir, '.local/clickup-homolog.json'))).toBe(false);
  }
  const fresh = clone('fresh');
  const r = flow(fresh, 'init');
  expect(r.code).toBe(0);
  const marker = join(fresh, '.local/clickup-homolog.json');
  expect(statSync(marker).mode & 0o777).toBe(0o600);
  expect(statSync(join(fresh, '.local')).mode & 0o777).toBe(0o700);
  expect(JSON.parse(readFileSync(marker, 'utf8')).purpose).toBe(
    'clickup-homologation',
  );
  expect(flow(fresh, 'init').code).toBe(1);
});

test('without the mark of a fresh clone, the check stops before touching anything', () => {
  const dir = clone('unmarked');
  mkdirSync(join(dir, '.local'));
  writeFileSync(
    join(dir, '.local/database.env'),
    'MIGRATION_DATABASE_URL=postgres://x:y@127.0.0.1:1/catus\n',
  );
  const r = flow(dir);
  expect(r.code).toBe(1);
  expect(r.out).toContain('FALHA');
  expect(r.out).toContain('Clone de homologação');
  expect(r.out).not.toContain('Banco isolado');
});
