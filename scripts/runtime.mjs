import { readFileSync, existsSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { readSecretFile } from './lib/secret-file.mjs';
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
  for (const key of [
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'CODEX_API_KEY',
    'OPENAI_API_KEY',
    'CODEX_GATEWAY_CONTROL_TOKEN',
    'CODEX_UPSTREAM_KEY',
    'DELIVERY_RUNNER_TOKEN',
    'CLICKUP_API_TOKEN',
    'CLICKUP_API_TOKEN_FILE',
  ])
    delete env[key];
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
  for (const key of [
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'CODEX_API_KEY',
    'OPENAI_API_KEY',
    'CODEX_GATEWAY_CONTROL_TOKEN',
    'CODEX_UPSTREAM_KEY',
    'DELIVERY_RUNNER_TOKEN',
    'CLICKUP_API_TOKEN',
    'CLICKUP_API_TOKEN_FILE',
  ])
    delete env[key];
  return Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined),
  );
}
/** Its own database account and token, and none of the other services' secrets. */
export function clickupWorkerEnvironment(base, local, roles) {
  const env = { ...local, ...base };
  env.CLICKUP_WORKER_DATABASE_URL =
    base.CLICKUP_WORKER_DATABASE_URL ||
    local.CLICKUP_WORKER_DATABASE_URL ||
    roles.CLICKUP_WORKER_DATABASE_URL;
  for (const name of Object.keys(env))
    if (
      (name.includes('DATABASE') &&
        name.endsWith('_URL') &&
        name !== 'CLICKUP_WORKER_DATABASE_URL') ||
      ['PGPASSWORD', 'PGPASSFILE', 'BACKUP_KEY_FILE'].includes(name)
    )
      delete env[name];
  for (const key of [
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'CODEX_API_KEY',
    'OPENAI_API_KEY',
    'LLM_API_KEY',
    'CODEX_GATEWAY_CONTROL_TOKEN',
    'CODEX_UPSTREAM_KEY',
    'DELIVERY_RUNNER_TOKEN',
    'OIDC_CLIENT_SECRET',
  ])
    delete env[key];
  // A token file is read here, as data: never sourced by a shell. It must be outside the
  // repository and writable only by this user (scripts/lib/secret-file.mjs).
  if (env.CLICKUP_API_TOKEN_FILE) {
    if (env.CLICKUP_API_TOKEN)
      throw new Error(
        'Use CLICKUP_API_TOKEN or CLICKUP_API_TOKEN_FILE, not both',
      );
    env.CLICKUP_API_TOKEN = readSecretFile(env.CLICKUP_API_TOKEN_FILE, {
      repository: process.cwd(),
    });
    delete env.CLICKUP_API_TOKEN_FILE;
  }
  return Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined),
  );
}
if (
  import.meta.url === new URL('file://' + resolve(process.argv[1] ?? '')).href
) {
  const worker = process.argv.includes('--ai-worker');
  const clickup = process.argv.includes('--clickup-worker');
  const databaseKey = clickup
    ? 'CLICKUP_WORKER_DATABASE_URL'
    : worker
      ? 'AI_WORKER_DATABASE_URL'
      : 'RUNTIME_DATABASE_URL';
  const local =
    !process.env[databaseKey] && existsSync('.env')
      ? parseEnv(readFileSync('.env', 'utf8'))
      : {};
  // Explicit runtime URL allows an isolated service account with no access to role files.
  const roles =
    process.env[databaseKey] ||
    local[databaseKey] ||
    // With the integration off the worker only reports that and leaves.
    (clickup && !existsSync('.local/database.env'))
      ? {}
      : parseEnv(readFileSync('.local/database.env', 'utf8'));
  const env = clickup
    ? clickupWorkerEnvironment(process.env, local, roles)
    : worker
      ? workerEnvironment(process.env, local, roles)
      : runtimeEnvironment(process.env, local, roles);
  const binary = resolve('node_modules/.bin/bun');
  const args = [
    'bun',
    '--no-env-file',
    ...(process.argv.includes('--watch') ? ['--watch'] : []),
    clickup
      ? 'scripts/clickup-worker.ts'
      : worker
        ? 'scripts/ai-worker.ts'
        : 'src/server/index.ts',
    ...((worker || clickup) && process.argv.includes('--once')
      ? ['--once']
      : []),
  ];
  if (typeof process.execve === 'function') process.execve(binary, args, env);
  else {
    const child = spawn(binary, args.slice(1), { env, stdio: 'inherit' });
    for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => child.kill(s));
    child.on('exit', (c) => process.exit(c ?? 1));
  }
}
