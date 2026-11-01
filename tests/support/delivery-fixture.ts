// Deterministic CodeAgent exclusively for automated tests. Never imported by production runner/API.
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { command } from '../../runner/src/core';
import type { RunnerRepo, CodeAgent } from '../../runner/src/core';
import type { DeliverySettings } from '../../src/shared/delivery';
import type { DeliveryConfig } from '../../src/server/delivery/config';
export const fixtureAgent: CodeAgent = {
  kind: 'test-fixture',
  generate: async (_task, sources, signal) => {
    if (signal.aborted) throw new Error('cancelled');
    return {
      files: [
        {
          path: 'templates/home.tpl',
          content: sources['templates/home.tpl']!.replace(
            '<h1>Loja</h1>',
            '<h1>Bem-vindo à loja sintética</h1>',
          ),
        },
      ],
      input_tokens: null,
      output_tokens: null,
    };
  },
};
export async function fixtureRepository() {
  const root = await mkdtemp(join(tmpdir(), 'catus-theme-fixture-'));
  for (const path of ['templates/home.tpl', 'tests/theme.test.mjs']) {
    await mkdir(join(root, path.split('/')[0]!), { recursive: true });
    await writeFile(
      join(root, path),
      await readFile(
        resolve(
          'tests/fixtures/nuvemshop-theme',
          path === 'tests/theme.test.mjs' ? 'theme-check.fixture' : path,
        ),
      ),
    );
  }
  const env = {
    PATH: process.env.PATH,
    HOME: '/nonexistent',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };
  const git = async (args: string[]) => {
    const r = await command(
      ['git', '-c', 'core.hooksPath=/dev/null', ...args],
      { cwd: root, env },
    );
    if (r.code) throw new Error('Fixture git failed');
    return r.out.trim();
  };
  await git(['init', '--initial-branch=fixture-base']);
  await git(['add', '--all']);
  await git([
    '-c',
    'user.name=Synthetic test fixture',
    '-c',
    'user.email=synthetic@invalid.test',
    'commit',
    '--no-gpg-sign',
    '-m',
    'Synthetic Nuvemshop baseline',
  ]);
  const sha = await git(['rev-parse', 'HEAD']);
  const repo: RunnerRepo = {
    key: 'synthetic-nuvemshop',
    repository: 'https://github.com/catus-synthetic/nuvemshop-theme',
    base_branch: 'fixture-base',
    base_sha: sha,
    mirror_path: root,
    allowed_paths: ['templates/home.tpl'],
    read_paths: ['templates/home.tpl', 'tests/theme.test.mjs'],
    test_argv: [['node', '--test', 'tests/theme.test.mjs']],
  };
  const config: DeliveryConfig = {
    available: true,
    reason: 'TEST FIXTURE ONLY: Codex real NOT_VERIFIED',
    repos: [repo],
    fixture: true,
  };
  const settings: DeliverySettings = {
    repo_key: repo.key,
    repository: repo.repository,
    base_branch: repo.base_branch,
    base_sha: repo.base_sha,
    allowed_paths: repo.allowed_paths,
    task_types: ['nuvemshop-theme'],
    harness: 'responses-api',
    timeout_seconds: 20,
    max_input_tokens: 16000,
    max_output_tokens: 1024,
    input_micro_usd_per_million: '1000000',
    output_micro_usd_per_million: '2000000',
    job_budget_micro_usd: '100000',
    daily_budget_micro_usd: '1000000',
    total_budget_micro_usd: '10000000',
    daily_job_limit: 10,
    concurrency: 1,
    attempt_limit: 1,
    min_margin_bps: 1000,
    report_max_age_minutes: 60,
    max_diff_bytes: 8192,
  };
  return {
    root,
    repo,
    config,
    settings,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
export const themeIntakeSource =
  'Reunião Nuvemshop sintética. Corrigir o título acessível do tema para Bem-vindo à loja sintética, preservando a seção hero.';
export function themeIntakeFixture() {
  const fact = { text: themeIntakeSource, evidence: [themeIntakeSource] };
  return {
    version: 1,
    summary: fact,
    requirements: [fact],
    decisions: [],
    commitments: [],
    missing_information: [],
    questions: [],
    proposals: [
      {
        title: 'Título acessível Nuvemshop sintético',
        description: themeIntakeSource,
        evidence: [themeIntakeSource],
        acceptance_criteria: [fact],
      },
    ],
  };
}
