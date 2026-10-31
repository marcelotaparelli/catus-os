import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  chmodSync,
  statSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  openSync,
  fsyncSync,
  closeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import pg from 'pg';
import { applyGrants } from './privileges';
export const postgresClientImage =
  'postgres@sha256:7e32e9833a6fb1c92c32552794cb6ed569d51b445a54907d35fc112ef39684db';
const header = Buffer.from('CATUSB1\n');
function key(file: string) {
  if ((statSync(file).mode & 0o077) !== 0)
    throw new Error('Backup key must have private file permissions');
  const k = readFileSync(file);
  if (k.length !== 32)
    throw new Error('Backup key must contain exactly 32 random bytes');
  return k;
}
function connection(value: string) {
  const u = new URL(value);
  if (!['127.0.0.1', 'localhost'].includes(u.hostname))
    throw new Error(
      'Backup/restore tooling is restricted to loopback homologation',
    );
  return u;
}
function client(
  url: URL,
  tool: 'pg_dump' | 'pg_restore',
  extra: string[],
  stdin?: string,
) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PGPASSWORD: decodeURIComponent(url.password),
  };
  for (const k of [
    'DOCKER_HOST',
    'DOCKER_CONTEXT',
    'DOCKER_TLS',
    'DOCKER_TLS_VERIFY',
    'DOCKER_CERT_PATH',
  ])
    delete env[k];
  return Bun.spawn(
    [
      'docker',
      '--host=unix:///var/run/docker.sock',
      'run',
      '--rm',
      '--network',
      'host',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--user',
      `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=16m',
      ...(stdin ? ['-i'] : []),
      '-e',
      'PGPASSWORD',
      '--entrypoint',
      tool,
      postgresClientImage,
      '--host',
      url.hostname,
      '--port',
      url.port || '5432',
      '--username',
      decodeURIComponent(url.username),
      '--dbname',
      decodeURIComponent(url.pathname.slice(1)),
      ...extra,
    ],
    {
      env,
      stdin: stdin ? Bun.file(stdin) : 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
}
export async function backup(url: string, out: string, keyFile: string) {
  const u = connection(url),
    k = key(keyFile);
  if (existsSync(out)) throw new Error('Backup destination already exists');
  mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
  chmodSync(dirname(out), 0o700);
  const partial = out + '.partial-' + crypto.randomUUID();
  const nonce = randomBytes(12);
  writeFileSync(partial, Buffer.concat([header, nonce]), {
    mode: 0o600,
    flag: 'wx',
  });
  const child = client(u, 'pg_dump', [
    '--format=custom',
    '--no-owner',
    '--no-privileges',
  ]);
  const errorOutput = new Response(child.stderr).text();
  try {
    const cipher = createCipheriv('aes-256-gcm', k, nonce);
    cipher.setAAD(header);
    await pipeline(
      Readable.from(
        (async function* () {
          const reader = child.stdout.getReader();
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              yield value;
            }
          } finally {
            reader.releaseLock();
          }
        })(),
      ),
      cipher,
      createWriteStream(partial, { flags: 'a', mode: 0o600 }),
    );
    if ((await child.exited) !== 0) {
      await errorOutput;
      throw new Error('pg_dump failed; archive not completed');
    }
    await errorOutput;
    writeFileSync(partial, cipher.getAuthTag(), { flag: 'a' });
    if (existsSync(out))
      throw new Error('Backup destination appeared concurrently');
    const fd = openSync(partial, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(partial, out);
    const directory = openSync(dirname(out), 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } catch (e) {
    child.kill();
    if (existsSync(partial)) unlinkSync(partial);
    throw e;
  }
  return { bytes: statSync(out).size };
}
export async function restore(
  url: string,
  archive: string,
  keyFile: string,
  runtime: string,
  maintenance: string,
) {
  const u = connection(url);
  if (!/^[a-z][a-z0-9_]*_restore_test$/.test(u.pathname.slice(1)))
    throw new Error('Restore requires a disposable *_restore_test database');
  const db = new pg.Pool({ connectionString: url });
  const c = await db.connect();
  const plain = archive + '.restore-' + crypto.randomUUID();
  try {
    if (
      (
        await c.query(
          "SELECT 1 FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') AND schemaname NOT LIKE 'pg_toast%' LIMIT 1",
        )
      ).rowCount
    )
      throw new Error(
        'Restore target must be empty; existing databases are never overwritten',
      );
    const size = statSync(archive).size;
    if (size < 37) throw new Error('Invalid archive');
    const file = await Bun.file(archive).slice(0, 20).arrayBuffer();
    const prefix = Buffer.from(file);
    if (!prefix.subarray(0, 8).equals(header))
      throw new Error('Invalid archive format');
    const tag = Buffer.from(
      await Bun.file(archive)
        .slice(size - 16)
        .arrayBuffer(),
    );
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key(keyFile),
      prefix.subarray(8),
    );
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    // Authenticate the entire encrypted stream BEFORE invoking pg_restore.
    await pipeline(
      createReadStream(archive, { start: 20, end: size - 17 }),
      decipher,
      createWriteStream(plain, { flags: 'wx', mode: 0o600 }),
    );
    const child = client(
      u,
      'pg_restore',
      [
        '--single-transaction',
        '--exit-on-error',
        '--no-owner',
        '--no-privileges',
      ],
      plain,
    );
    const stderr = new Response(child.stderr).text();
    const stdout = new Response(child.stdout).text();
    const exit = await child.exited;
    await Promise.all([stderr, stdout]);
    if (exit !== 0)
      throw new Error('pg_restore failed; restore transaction rolled back');
    await c.query('BEGIN');
    for (const table of [
      'sessions',
      'oidc_transactions',
      'rate_limits',
      'idempotency_keys',
    ])
      if (
        (await c.query('SELECT to_regclass($1) present', ['public.' + table]))
          .rows[0].present
      )
        await c.query(`DELETE FROM ${table}`);
    await applyGrants(c, runtime, maintenance);
    await c.query('COMMIT');
    return { restored: true, sessionsInvalidated: true };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    if (existsSync(plain)) unlinkSync(plain);
    c.release();
    await db.end();
  }
}
