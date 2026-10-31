import { readFileSync, existsSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
export function runtimeEnvironment(base, local, roles) {
  const env = { ...local, ...base };
  env.RUNTIME_DATABASE_URL =
    base.RUNTIME_DATABASE_URL ||
    local.RUNTIME_DATABASE_URL ||
    roles.RUNTIME_DATABASE_URL;
  if (!env.RUNTIME_DATABASE_URL)
    throw new Error('RUNTIME_DATABASE_URL required; prepare db:roles');
  for (const key of [
    'DATABASE_URL',
    'MIGRATION_DATABASE_URL',
    'MAINTENANCE_DATABASE_URL',
    'RESTORE_DATABASE_URL',
    'BACKUP_KEY_FILE',
    'DB_RUNTIME_ROLE',
    'DB_MAINTENANCE_ROLE',
  ])
    delete env[key];
  for (const name of Object.keys(env))
    if (
      (name.includes('DATABASE') &&
        name.endsWith('_URL') &&
        name !== 'RUNTIME_DATABASE_URL') ||
      ['PGPASSWORD', 'PGPASSFILE'].includes(name)
    )
      delete env[name];
  return Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined),
  );
}
export function workerEnvironment(base, local, roles) {
  const env = { ...local, ...base };
  env.AI_WORKER_DATABASE_URL =
    base.AI_WORKER_DATABASE_URL ||
    local.AI_WORKER_DATABASE_URL ||
    roles.AI_WORKER_DATABASE_URL;
  if (!env.AI_WORKER_DATABASE_URL)
    throw new Error('AI_WORKER_DATABASE_URL required');
  for (const name of Object.keys(env))
    if (
      (name.includes('DATABASE') &&
        name.endsWith('_URL') &&
        name !== 'AI_WORKER_DATABASE_URL') ||
      ['PGPASSWORD', 'PGPASSFILE', 'BACKUP_KEY_FILE'].includes(name)
    )
      delete env[name];
  return Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined),
  );
}
if (
  import.meta.url === new URL('file://' + resolve(process.argv[1] ?? '')).href
) {
  const worker = process.argv.includes('--ai-worker');
  const databaseKey = worker
    ? 'AI_WORKER_DATABASE_URL'
    : 'RUNTIME_DATABASE_URL';
  const local =
    !process.env[databaseKey] && existsSync('.env')
      ? parseEnv(readFileSync('.env', 'utf8'))
      : {};
  // Explicit runtime URL allows an isolated service account with no access to role files.
  const roles =
    process.env[databaseKey] || local[databaseKey]
      ? {}
      : parseEnv(readFileSync('.local/database.env', 'utf8'));
  const env = worker
    ? workerEnvironment(process.env, local, roles)
    : runtimeEnvironment(process.env, local, roles);
  const binary = resolve('node_modules/.bin/bun');
  const args = [
    'bun',
    '--no-env-file',
    ...(process.argv.includes('--watch') ? ['--watch'] : []),
    worker ? 'scripts/ai-worker.ts' : 'src/server/index.ts',
    ...(worker && process.argv.includes('--once') ? ['--once'] : []),
  ];
  if (typeof process.execve === 'function') process.execve(binary, args, env);
  else {
    const child = spawn(binary, args.slice(1), { env, stdio: 'inherit' });
    for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => child.kill(s));
    child.on('exit', (c) => process.exit(c ?? 1));
  }
}
