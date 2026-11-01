// Offline diagnostics: configuration is never promoted to acceptance evidence.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { command } from './core.ts';
import type { RunnerRepo } from './core.ts';
export async function readiness(env: NodeJS.ProcessEnv = process.env) {
  const boundaries: { boundary: string; status: string; reason: string }[] = [];
  const configured = (boundary: string, names: string[]) =>
    boundaries.push({
      boundary,
      status: names.every((n) => !!env[n])
        ? 'CONFIGURED_NOT_VERIFIED'
        : 'DENIED',
      reason: names.every((n) => !!env[n])
        ? 'Requires private runtime evidence'
        : 'Missing required configuration',
    });
  configured('provider access', ['CODEX_UPSTREAM_KEY']);
  configured('model / json_schema', [
    'CODEX_MODEL',
    'CODEX_UPSTREAM_RESPONSES_URL',
  ]);
  configured('gateway / egress', [
    'CODEX_GATEWAY_CONTROL_URL',
    'CODEX_GATEWAY_CONTROL_TOKEN',
    'DELIVERY_CODEX_NETWORK',
  ]);
  configured('worker', [
    'DELIVERY_API_URL',
    'DELIVERY_RUNNER_TOKEN',
    'DELIVERY_CODEX_IMAGE',
  ]);
  boundaries.push({
    boundary: 'policy',
    status:
      env.DELIVERY_ENABLED === 'true' &&
      env.DELIVERY_RUNNER_ATTESTATION === 'isolated-responses-capped-gateway-v1'
        ? 'CONFIGURED_NOT_VERIFIED'
        : 'DENIED',
    reason: 'Requires independent human authorization and current M3/M4 basis',
  });
  // Only allowlisted local checks. No fetch, credentials, prompt or provider probe.
  try {
    const d = await command(
      [
        'docker',
        '--host=unix:///var/run/docker.sock',
        'info',
        '--format',
        '{{.ServerVersion}}',
      ],
      {
        env: { PATH: env.PATH },
        signal: AbortSignal.timeout(3000),
        maxBytes: 1024,
      },
    );
    boundaries.push({
      boundary: 'Docker',
      status: d.code === 0 ? 'LOCAL_CHECK_PASSED' : 'DENIED',
      reason:
        d.code === 0
          ? 'Daemon responds; sandbox/network still require acceptance'
          : 'Daemon unavailable',
    });
  } catch {
    boundaries.push({
      boundary: 'Docker',
      status: 'DENIED',
      reason: 'Daemon unavailable',
    });
  }
  try {
    const repos = JSON.parse(
      await readFile(env.DELIVERY_RUNNER_REPOS_FILE ?? '', 'utf8'),
    ) as RunnerRepo[];
    if (!Array.isArray(repos) || !repos.length || repos.length > 20)
      throw Error();
    for (const repo of repos) {
      if (
        !/^[a-f0-9]{40}$/.test(repo.base_sha) ||
        /^0+$/.test(repo.base_sha) ||
        !/^[a-zA-Z0-9_/-]{1,120}$/.test(repo.base_branch) ||
        !repo.mirror_path?.startsWith('/')
      )
        throw Error();
      const r = await command(
        [
          'git',
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'core.fsmonitor=false',
          '-C',
          repo.mirror_path,
          'rev-parse',
          '--verify',
          'refs/heads/' + repo.base_branch,
        ],
        {
          env: {
            PATH: env.PATH,
            HOME: '/nonexistent',
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
          },
          signal: AbortSignal.timeout(3000),
          maxBytes: 1024,
        },
      );
      if (r.code || r.out.trim() !== repo.base_sha) throw Error();
    }
    boundaries.push({
      boundary: 'mirror SHA',
      status: 'LOCAL_CHECK_PASSED',
      reason: 'Configured refs match; content authorization still required',
    });
  } catch {
    boundaries.push({
      boundary: 'mirror SHA',
      status: 'DENIED',
      reason: 'Missing/invalid manifest or reviewed ref/SHA mismatch',
    });
  }
  for (const [boundary, reason] of [
    [
      'fixture repo',
      'Owner must authorize synthetic repository and failing-before/passing-after evidence',
    ],
    [
      'time / cost',
      'Explicit per-job/daily/total prices and limits must match policy and provider account',
    ],
    [
      'PR option',
      'PR NOT_CREATED: separate minimal credential and authorized repository/base required',
    ],
  ])
    boundaries.push({
      boundary: boundary!,
      status: 'NOT_VERIFIED',
      reason: reason!,
    });
  return {
    preparation: 'CONFIGURATION_REPORT_ONLY',
    real_inference: 'NOT_VERIFIED',
    codex_sdk: 'DISABLED_INCOMPATIBLE_NO_TOOLS',
    pr: 'NOT_CREATED',
    boundaries,
  };
}
if (
  import.meta.url === new URL('file://' + resolve(process.argv[1] ?? '')).href
) {
  console.log(JSON.stringify(await readiness(), null, 2));
  process.exitCode = 2;
}
