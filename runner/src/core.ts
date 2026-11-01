import { spawn } from 'node:child_process';
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  rm,
  realpath,
  lstat,
  readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type {
  DeliveryTask,
  DeliveryResult,
} from '../../src/shared/delivery.ts';
import { validPath, validThemePath } from '../../src/shared/delivery.ts';
export const TEST_IMAGE =
  'node@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da';
export interface RunnerRepo {
  key: string;
  repository: string;
  base_branch: string;
  base_sha: string;
  allowed_paths: string[];
  mirror_path: string;
  read_paths: string[];
  test_argv: string[][];
}
export interface Changes {
  files: { path: string; content: string }[];
  input_tokens: number | null;
  output_tokens: number | null;
}
export interface CodeAgent {
  kind: 'codex-sdk' | 'test-fixture';
  generate(
    task: DeliveryTask,
    sources: Record<string, string>,
    signal: AbortSignal,
  ): Promise<Changes>;
}
export class RunnerError extends Error {
  code:
    | 'unavailable'
    | 'timeout'
    | 'sandbox_failure'
    | 'invalid_changes'
    | 'tests_failed'
    | 'cancelled'
    | 'runner_failure';
  constructor(code: RunnerError['code']) {
    super(code);
    this.code = code;
  }
}
export const secretPattern =
  /sk-[a-zA-Z0-9_-]{12,}|BEGIN [A-Z ]*PRIVATE KEY|(?:Bearer|token|password|secret)\s*[:= ]\s*[A-Za-z0-9_./+-]{16,}/gi;
export function sanitize(s: string) {
  return s
    .replace(secretPattern, '[REDACTED]')
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[REDACTED]')
    .slice(0, 1400);
}
function safeText(s: string) {
  secretPattern.lastIndex = 0;
  return !secretPattern.test(s) && !s.includes('\0');
}
export async function command(
  argv: string[],
  options: {
    cwd?: string;
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
    maxBytes?: number;
  } = {},
): Promise<{ code: number; out: string; err: string }> {
  if (!argv.length) throw new RunnerError('runner_failure');
  return new Promise((res, rej) => {
    let out = '',
      err = '',
      bytes = 0,
      done = false;
    const p = spawn(argv[0]!, argv.slice(1), {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: options.signal,
    });
    const append = (chunk: Buffer, stderr: boolean) => {
      bytes += chunk.length;
      if (bytes > (options.maxBytes ?? 65536)) {
        p.kill('SIGKILL');
        if (!done) {
          done = true;
          rej(new RunnerError('runner_failure'));
        }
        return;
      }
      if (stderr) err += chunk.toString('utf8');
      else out += chunk.toString('utf8');
    };
    p.stdout.on('data', (b) => append(b, false));
    p.stderr.on('data', (b) => append(b, true));
    p.on('error', () => {
      if (!done) {
        done = true;
        rej(
          new RunnerError(
            options.signal?.aborted ? 'cancelled' : 'runner_failure',
          ),
        );
      }
    });
    p.on('exit', (code) => {
      if (!done) {
        done = true;
        res({ code: code ?? -1, out, err });
      }
    });
  });
}
function gitEnv() {
  return {
    PATH: process.env.PATH,
    HOME: '/nonexistent',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    LANG: 'C.UTF-8',
  };
}
const git = (args: string[], cwd?: string, signal?: AbortSignal) =>
  command(
    [
      'git',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.attributesFile=/dev/null',
      ...args,
    ],
    { cwd, env: gitEnv(), signal, maxBytes: 200000 },
  );
function dockerEnv() {
  const env = { ...process.env };
  for (const k of [
    'DOCKER_HOST',
    'DOCKER_CONTEXT',
    'DOCKER_TLS',
    'DOCKER_TLS_VERIFY',
    'DOCKER_CERT_PATH',
  ])
    delete env[k];
  return env;
}
export const docker = (
  args: string[],
  signal?: AbortSignal,
  extraEnv: Record<string, string> = {},
) =>
  command(['docker', '--host=unix:///var/run/docker.sock', ...args], {
    env: { ...dockerEnv(), ...extraEnv },
    signal,
    maxBytes: 32768,
  });
export function isolatedUser() {
  const uid = process.getuid?.(),
    gid = process.getgid?.();
  if (uid === undefined || gid === undefined || uid === 0)
    throw new RunnerError('sandbox_failure');
  return `${uid}:${gid}`;
}
export function nodeSupervisor(milliseconds: number) {
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < 100 ||
    milliseconds > 120000
  )
    throw new RunnerError('sandbox_failure');
  return (
    "const{spawn}=require('node:child_process');const p=spawn(process.execPath,process.argv.slice(1),{stdio:'inherit',detached:true});const t=setTimeout(()=>{try{process.kill(-p.pid,'SIGKILL')}catch{}process.exit(124)}," +
    milliseconds +
    ");p.on('error',()=>process.exit(125));p.on('exit',c=>{clearTimeout(t);process.exit(c??125)});"
  );
}
export async function isolatedTest(
  work: string,
  argv: string[],
  signal: AbortSignal,
  name = 'catus-test-' + crypto.randomUUID(),
  maximumMs = 10000,
) {
  if (
    argv[0] !== 'node' ||
    argv[1] !== '--test' ||
    argv.length < 3 ||
    argv.length > 8 ||
    !argv.slice(2).every(validPath)
  )
    throw new RunnerError('sandbox_failure');
  try {
    const result = await docker(
      [
        'run',
        '--rm',
        '--name',
        name,
        '--network',
        'none',
        '--read-only',
        '--user',
        isolatedUser(),
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--pids-limit',
        '32',
        '--memory',
        '128m',
        '--memory-swap',
        '128m',
        '--cpus',
        '0.5',
        '--ulimit',
        'nofile=128:128',
        '--ulimit',
        'fsize=1048576:1048576',
        '--tmpfs',
        '/tmp:rw,noexec,nosuid,size=16m',
        '-e',
        'HTTP_PROXY=',
        '-e',
        'HTTPS_PROXY=',
        '-e',
        'ALL_PROXY=',
        '-e',
        'NO_PROXY=*',
        '--mount',
        `type=bind,src=${work},dst=/work,readonly`,
        '--workdir',
        '/work',
        '--entrypoint',
        'node',
        TEST_IMAGE,
        '-e',
        nodeSupervisor(maximumMs),
        '--',
        ...argv.slice(1),
      ],
      signal,
    );
    return {
      argv,
      exit_code: result.code,
      log: sanitize(result.out + '\n' + result.err).trim() || 'No test output',
    };
  } finally {
    await docker(['rm', '-f', name]).catch(() => {});
    const check = await docker(['container', 'inspect', name]);
    if (check.code === 0) throw new RunnerError('sandbox_failure');
  }
}
export function validateChanges(changes: Changes, task: DeliveryTask) {
  if (
    !Array.isArray(changes.files) ||
    !changes.files.length ||
    changes.files.length > 20 ||
    new Set(changes.files.map((f) => f.path)).size !== changes.files.length
  )
    throw new RunnerError('invalid_changes');
  let total = 0;
  for (const f of changes.files) {
    if (
      !validThemePath(f.path) ||
      !task.allowed_paths.includes(f.path) ||
      typeof f.content !== 'string' ||
      !safeText(f.content)
    )
      throw new RunnerError('invalid_changes');
    total += Buffer.byteLength(f.content);
  }
  if (total > task.settings.max_diff_bytes)
    throw new RunnerError('invalid_changes');
  const limits: [number | null, number][] = [
    [changes.input_tokens, task.settings.max_input_tokens],
    [changes.output_tokens, task.settings.max_output_tokens],
  ];
  for (const [value, limit] of limits)
    if (
      value !== null &&
      (!Number.isSafeInteger(value) || value! < 0 || value! > limit)
    )
      throw new RunnerError('invalid_changes');
}
export async function executeTask(
  task: DeliveryTask,
  repo: RunnerRepo,
  agent: CodeAgent,
  signal: AbortSignal,
): Promise<DeliveryResult> {
  const started = Date.now();
  if (
    repo.key !== task.repo_key ||
    repo.repository !== task.repository ||
    repo.base_branch !== task.base_branch ||
    repo.base_sha !== task.base_sha ||
    !task.allowed_paths.every(
      (p) => validThemePath(p) && repo.allowed_paths.includes(p),
    )
  )
    throw new RunnerError('sandbox_failure');
  const mirror = await realpath(repo.mirror_path);
  if (
    (await lstat(repo.mirror_path)).isSymbolicLink() ||
    !resolve(repo.mirror_path).startsWith('/') ||
    !repo.read_paths.length ||
    repo.read_paths.length > 100 ||
    !repo.read_paths.every(validPath)
  )
    throw new RunnerError('sandbox_failure');
  const ref = await git(
    ['rev-parse', '--verify', 'refs/heads/' + repo.base_branch],
    mirror,
    signal,
  );
  if (ref.code || ref.out.trim() !== repo.base_sha)
    throw new RunnerError('sandbox_failure');
  const dir = await mkdtemp(join(tmpdir(), 'catus-delivery-')),
    work = join(dir, 'work');
  await mkdir(work);
  let result: DeliveryResult | undefined;
  try {
    const sources: Record<string, string> = {};
    let bytes = 0;
    for (const path of [
      ...new Set([...repo.read_paths, ...repo.allowed_paths]),
    ].sort()) {
      const entry = await git(
        ['ls-tree', repo.base_sha, '--', path],
        mirror,
        signal,
      );
      if (
        entry.code ||
        !entry.out.startsWith('100644 blob ') ||
        entry.out.trim().split('\n').length !== 1
      )
        throw new RunnerError('sandbox_failure');
      const blob = await git(
        ['cat-file', 'blob', repo.base_sha + ':' + path],
        mirror,
        signal,
      );
      if (blob.code || !safeText(blob.out))
        throw new RunnerError('sandbox_failure');
      bytes += Buffer.byteLength(blob.out);
      if (bytes > 64000) throw new RunnerError('sandbox_failure');
      sources[path] = blob.out;
      await mkdir(dirname(join(work, path)), { recursive: true });
      await writeFile(join(work, path), blob.out, { mode: 0o600 });
    }
    const promptBytes = Buffer.byteLength(
      JSON.stringify({
        task: task.specification,
        acceptance: task.acceptance,
        sources,
      }),
    );
    if (promptBytes + 2048 > task.settings.max_input_tokens)
      throw new RunnerError('unavailable');
    await git(['init', '--initial-branch=catus-sandbox'], work, signal);
    await git(['add', '--all'], work, signal);
    const commit = await git(
      [
        '-c',
        'user.name=Catus isolated runner',
        '-c',
        'user.email=runner@synthetic.invalid',
        'commit',
        '--no-gpg-sign',
        '-m',
        'Isolated authorized baseline',
      ],
      work,
      signal,
    );
    if (commit.code) throw new RunnerError('sandbox_failure');
    const changes = await agent.generate(task, sources, signal);
    if (signal.aborted) throw new RunnerError('cancelled');
    validateChanges(changes, task);
    for (const file of changes.files) {
      const dest = join(work, file.path);
      if (!(await lstat(dest)).isFile())
        throw new RunnerError('invalid_changes');
      await writeFile(dest, file.content, { mode: 0o600 });
    }
    const touched = await git(
      ['diff', '--name-only', '--no-ext-diff', '--no-textconv'],
      work,
      signal,
    );
    const files = touched.out.trim().split('\n').filter(Boolean);
    if (
      touched.code ||
      !files.length ||
      files.some((p) => !task.allowed_paths.includes(p))
    )
      throw new RunnerError('invalid_changes');
    const tests = [];
    for (const argv of repo.test_argv) {
      const test = await isolatedTest(
        work,
        argv,
        signal,
        undefined,
        task.settings.timeout_seconds * 1000,
      );
      tests.push(test);
      if (test.exit_code !== 0) throw new RunnerError('tests_failed');
    }
    if (!tests.length) throw new RunnerError('sandbox_failure');
    const diff = await git(
      ['diff', '--no-ext-diff', '--no-textconv', '--no-color'],
      work,
      signal,
    );
    if (
      diff.code ||
      Buffer.byteLength(diff.out) > task.settings.max_diff_bytes ||
      !safeText(diff.out)
    )
      throw new RunnerError('invalid_changes');
    result = {
      harness: agent.kind,
      llm_verified: agent.kind === 'codex-sdk',
      base_sha: repo.base_sha,
      patch: diff.out,
      files,
      tests,
      input_tokens: changes.input_tokens,
      output_tokens: changes.output_tokens,
      latency_ms: Date.now() - started,
      cleanup_confirmed: false,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
    try {
      await lstat(dir);
      throw new RunnerError('sandbox_failure');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  if (!result) throw new RunnerError('runner_failure');
  result.cleanup_confirmed = true;
  return result;
}
export interface Broker {
  claim(): Promise<{ task: DeliveryTask | null; lease?: string }>;
  post(
    job: string,
    action: string,
    body: unknown,
  ): Promise<{ cancel?: boolean }>;
}
export async function runnerCycle(
  broker: Broker,
  repos: RunnerRepo[],
  agent: CodeAgent,
) {
  const claim = await broker.claim();
  if (!claim.task) return false;
  const task = claim.task,
    lease = claim.lease;
  if (!lease) throw new RunnerError('runner_failure');
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    task.settings.timeout_seconds * 1000,
  );
  let heartbeat: ReturnType<typeof setInterval> | undefined,
    checking = false;
  try {
    const start = await broker.post(task.job_id, 'start', { lease });
    if (start.cancel) return true;
    heartbeat = setInterval(() => {
      if (checking) return;
      checking = true;
      void broker
        .post(task.job_id, 'heartbeat', { lease })
        .then((r) => {
          if (r.cancel) controller.abort();
        })
        .catch(() => controller.abort())
        .finally(() => (checking = false));
    }, 500);
    const repo = repos.find((r) => r.key === task.repo_key);
    if (!repo) throw new RunnerError('sandbox_failure');
    const result = await executeTask(task, repo, agent, controller.signal);
    await broker.post(task.job_id, 'finish', { lease, result });
  } catch (e) {
    const failure_code = controller.signal.aborted
      ? 'timeout'
      : e instanceof RunnerError
        ? e.code
        : 'runner_failure';
    await broker
      .post(task.job_id, 'finish', { lease, failure_code })
      .catch(() => {});
  } finally {
    clearTimeout(timeout);
    if (heartbeat) clearInterval(heartbeat);
  }
  return true;
}
