import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  docker,
  RunnerError,
  validateChanges,
  nodeSupervisor,
  isolatedUser,
} from './core.ts';
import type { CodeAgent, Changes } from './core.ts';
import type { DeliveryTask } from '../../src/shared/delivery.ts';
export interface GatewayLease {
  url: string;
  token: string;
  max_input_tokens: number;
  max_output_tokens: number;
  max_requests: 1;
  job_budget_micro_usd: string;
}
export interface GatewayControl {
  allocate(task: DeliveryTask): Promise<GatewayLease>;
  close(job: string): Promise<void>;
}
export class ResponsesAgent implements CodeAgent {
  readonly kind = 'responses-api' as const;
  private gateway: GatewayControl;
  private network: string;
  private image: string;
  private model: string;
  constructor(
    gateway: GatewayControl,
    network: string,
    image: string,
    model: string,
  ) {
    this.gateway = gateway;
    this.network = network;
    this.image = image;
    this.model = model;
    if (
      !/^catus-codex-[a-z0-9-]+$/.test(network) ||
      !/^sha256:[a-f0-9]{64}$/.test(image) ||
      !model
    )
      throw new RunnerError('unavailable');
  }
  async generate(
    task: DeliveryTask,
    sources: Record<string, string>,
    signal: AbortSignal,
  ): Promise<Changes> {
    if (task.settings.harness !== this.kind || signal.aborted)
      throw new RunnerError('unavailable');
    const network = await docker([
      'network',
      'inspect',
      this.network,
      '--format',
      '{{.Internal}}',
    ]);
    if (network.code || network.out.trim() !== 'true')
      throw new RunnerError('sandbox_failure');
    const lease = await this.gateway.allocate(task);
    let dir: string | undefined;
    const name = 'catus-responses-' + crypto.randomUUID();
    try {
      const url = new URL(lease.url);
      if (
        url.hostname !== 'delivery-gateway' ||
        url.protocol !== 'http:' ||
        url.port !== '8080' ||
        url.pathname !== '/v1' ||
        url.search ||
        url.hash ||
        url.username ||
        url.password ||
        lease.max_requests !== 1 ||
        lease.max_input_tokens !== task.settings.max_input_tokens ||
        lease.max_output_tokens !== task.settings.max_output_tokens ||
        lease.job_budget_micro_usd !== task.settings.job_budget_micro_usd
      )
        throw new RunnerError('unavailable');
      dir = await mkdtemp(join(tmpdir(), 'catus-sdk-input-'));
      const file = join(dir, 'input.json');
      await writeFile(file, JSON.stringify({ task, sources }), { mode: 0o600 });
      const r = await docker(
        [
          'run',
          '--rm',
          '--name',
          name,
          '--network',
          this.network,
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
          '512m',
          '--memory-swap',
          '512m',
          '--cpus',
          '1',
          '--tmpfs',
          '/tmp:rw,nosuid,size=32m',
          '--mount',
          `type=bind,src=${file},dst=/input.json,readonly`,
          '-e',
          'CODEX_GATEWAY_TOKEN',
          '-e',
          'CODEX_GATEWAY_URL',
          '-e',
          'CODEX_MODEL',
          '--entrypoint',
          'node',
          this.image,
          '-e',
          nodeSupervisor(task.settings.timeout_seconds * 1000),
          '--',
          '--experimental-strip-types',
          '/runner/src/responses-entry.ts',
        ],
        signal,
        {
          CODEX_GATEWAY_TOKEN: lease.token,
          CODEX_GATEWAY_URL: lease.url,
          CODEX_MODEL: this.model,
        },
      );
      // Credentials are passed to docker via its environment, never argv or artifacts. SDK uses only a one-job capped gateway token.
      if (r.code) throw new RunnerError('unavailable');
      let changes: Changes;
      try {
        changes = JSON.parse(r.out);
      } catch {
        throw new RunnerError('invalid_changes');
      }
      validateChanges(changes, task);
      return changes;
    } finally {
      await docker(['rm', '-f', name]).catch(() => {});
      const remaining = await docker(['container', 'inspect', name]);
      await this.gateway.close(task.job_id).catch(() => {});
      if (dir) await rm(dir, { recursive: true, force: true });
      if (remaining.code === 0) throw new RunnerError('sandbox_failure');
    }
  }
}
