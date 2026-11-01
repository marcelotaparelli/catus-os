import { readFile } from 'node:fs/promises';
import { runnerCycle, RunnerError } from './core.ts';
import type { RunnerRepo, Broker } from './core.ts';
import { ResponsesAgent } from './responses-agent.ts';
import type { GatewayLease } from './responses-agent.ts';
for (const name of Object.keys(process.env))
  if (
    (name.includes('DATABASE') && name.endsWith('_URL')) ||
    [
      'PGPASSWORD',
      'PGPASSFILE',
      'BACKUP_KEY_FILE',
      'OPENAI_API_KEY',
      'CODEX_API_KEY',
      'GH_TOKEN',
      'GITHUB_TOKEN',
    ].includes(name)
  )
    throw new Error(
      'Runner must not inherit database/financial or upstream provider credentials',
    );
const required = [
  'DELIVERY_API_URL',
  'DELIVERY_RUNNER_TOKEN',
  'DELIVERY_RUNNER_REPOS_FILE',
  'DELIVERY_CODEX_NETWORK',
  'DELIVERY_CODEX_IMAGE',
  'CODEX_GATEWAY_CONTROL_URL',
  'CODEX_GATEWAY_CONTROL_TOKEN',
  'CODEX_MODEL',
] as const;
if (required.some((n) => !process.env[n])) {
  console.log(
    'unavailable: isolated runner/Responses/capped gateway/legitimate credentials not configured; Codex real NOT_VERIFIED',
  );
  process.exit(2);
}
const base = new URL(process.env.DELIVERY_API_URL!);
if (
  base.protocol !== 'https:' &&
  !(
    base.protocol === 'http:' &&
    ['127.0.0.1', 'localhost'].includes(base.hostname)
  )
)
  throw new Error('Private HTTPS or loopback required');
const gatewayUrl = new URL(process.env.CODEX_GATEWAY_CONTROL_URL!);
if (
  gatewayUrl.protocol !== 'https:' &&
  !(
    gatewayUrl.protocol === 'http:' &&
    ['127.0.0.1', 'localhost', 'delivery-gateway'].includes(gatewayUrl.hostname)
  )
)
  throw new Error('Private gateway HTTPS or loopback required');
const repos: RunnerRepo[] = JSON.parse(
  await readFile(process.env.DELIVERY_RUNNER_REPOS_FILE!, 'utf8'),
);
async function call<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(new URL('/api/delivery-runner/' + path, base), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + process.env.DELIVERY_RUNNER_TOKEN,
    },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) throw new RunnerError('runner_failure');
  return r.json() as Promise<T>;
}
const broker: Broker = {
  claim: () => call('claim', {}),
  post: (job, action, body) => call('jobs/' + job + '/' + action, body),
};
const agent = new ResponsesAgent(
  {
    allocate: async (task) => {
      const r = await fetch(new URL('/allocate', gatewayUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + process.env.CODEX_GATEWAY_CONTROL_TOKEN,
        },
        body: JSON.stringify(task),
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) throw new RunnerError('unavailable');
      return r.json() as Promise<GatewayLease>;
    },
    close: async (job) => {
      await fetch(new URL('/close', gatewayUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + process.env.CODEX_GATEWAY_CONTROL_TOKEN,
        },
        body: JSON.stringify({ job_id: job }),
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
    },
  },
  process.env.DELIVERY_CODEX_NETWORK!,
  process.env.DELIVERY_CODEX_IMAGE!,
  process.env.CODEX_MODEL!,
);
let stop = false;
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => (stop = true));
do {
  try {
    await runnerCycle(broker, repos, agent);
  } catch {
    console.error(
      'Delivery cycle failed; inspect broker state, no automatic retry of claimed work',
    );
  }
  if (!process.argv.includes('--once') && !stop)
    await new Promise((r) => setTimeout(r, 1000));
} while (!stop && !process.argv.includes('--once'));
