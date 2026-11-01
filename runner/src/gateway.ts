import { randomBytes, createHash } from 'node:crypto';
import type { DeliveryTask } from '../../src/shared/delivery.ts';
import type { GatewayLease } from './responses-agent.ts';
import { boundedJson, changesSchema, responseChanges } from './responses.ts';
import { validThemePath } from '../../src/shared/delivery.ts';
import type { Transport } from './responses.ts';
export class CappedGateway {
  private leases = new Map<
    string,
    { task: DeliveryTask; used: boolean; expires: number }
  >();
  constructor(
    private master: string,
    private upstreamKey: string,
    private upstream: string,
    private model: string,
    private transport: Transport = fetch,
  ) {
    const url = new URL(upstream);
    if (
      master.length < 32 ||
      !upstreamKey ||
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !model
    )
      throw new Error('Gateway configuration unavailable');
  }
  private hash(s: string) {
    return createHash('sha256').update(s).digest('hex');
  }
  async handle(request: Request): Promise<Response> {
    const deny = (error: string, status: number) =>
      Response.json(
        { error },
        { status, headers: { 'Cache-Control': 'no-store' } },
      );
    try {
      const url = new URL(request.url),
        path = url.pathname;
      const token = request.headers
        .get('authorization')
        ?.replace(/^Bearer /, '');
      if (request.method !== 'POST') return deny('method_denied', 405);
      if (
        url.search ||
        !['/allocate', '/close', '/v1/responses'].includes(path)
      )
        return deny('route_denied', 404);
      const lease = token ? this.leases.get(this.hash(token)) : undefined;
      if (
        path !== '/v1/responses'
          ? token !== this.master
          : !lease || lease.used || Date.now() >= lease.expires
      )
        return deny(
          path === '/v1/responses' ? 'budget_denied' : 'denied',
          path === '/v1/responses' ? 429 : 401,
        );
      const signal = AbortSignal.any([
        request.signal,
        AbortSignal.timeout(120000),
      ]);
      const b = await boundedJson(new Response(request.body), 128000, signal);
      if (!b || typeof b !== 'object' || Array.isArray(b))
        return deny('invalid_input', 422);
      if (path === '/allocate') {
        const task = b as DeliveryTask,
          s = task.settings;
        const integer = (v: number, min: number, max: number) =>
          Number.isSafeInteger(v) && v >= min && v <= max;
        const money = (v: string) =>
          typeof v === 'string' && /^[1-9][0-9]{0,15}$/.test(v);
        if (
          !task.job_id ||
          !s ||
          s.harness !== 'responses-api' ||
          !integer(s.timeout_seconds, 5, 120) ||
          !integer(s.max_input_tokens, 1000, 32000) ||
          !integer(s.max_output_tokens, 128, 4096) ||
          !money(s.input_micro_usd_per_million) ||
          !money(s.output_micro_usd_per_million) ||
          !money(s.job_budget_micro_usd) ||
          !Array.isArray(task.allowed_paths) ||
          !task.allowed_paths.length ||
          task.allowed_paths.length > 20 ||
          !task.allowed_paths.every(validThemePath)
        )
          return deny('invalid_limits', 422);
        const maximum =
          (BigInt(s.max_input_tokens) * BigInt(s.input_micro_usd_per_million) +
            BigInt(s.max_output_tokens) *
              BigInt(s.output_micro_usd_per_million) +
            999999n) /
          1000000n;
        if (
          maximum > BigInt(s.job_budget_micro_usd) ||
          BigInt(s.job_budget_micro_usd) > 10000000n
        )
          return deny('budget_denied', 429);
        if (
          [...this.leases.values()].some((v) => v.task.job_id === task.job_id)
        )
          return deny('already_allocated', 409);
        const credential = randomBytes(32).toString('base64url');
        this.leases.set(this.hash(credential), {
          task,
          used: false,
          expires: Date.now() + s.timeout_seconds * 1000,
        });
        const result: GatewayLease = {
          url: 'http://delivery-gateway:8080/v1',
          token: credential,
          max_input_tokens: s.max_input_tokens,
          max_output_tokens: s.max_output_tokens,
          max_requests: 1,
          job_budget_micro_usd: s.job_budget_micro_usd,
        };
        return Response.json(result, {
          headers: { 'Cache-Control': 'no-store' },
        });
      }
      if (path === '/close') {
        for (const l of this.leases.values())
          if (l.task.job_id === b.job_id) l.used = true;
        return Response.json({ closed: true });
      }
      const l = lease!,
        s = l.task.settings;
      if (Date.now() >= l.expires || l.used) return deny('budget_denied', 429);
      const allowed = [
        'model',
        'input',
        'tools',
        'tool_choice',
        'store',
        'stream',
        'max_output_tokens',
        'text',
      ];
      if (
        Object.keys(b).some((k) => !allowed.includes(k)) ||
        typeof b.input !== 'string' ||
        Buffer.byteLength(JSON.stringify(b)) + 2048 > s.max_input_tokens ||
        (b.tools !== undefined &&
          (!Array.isArray(b.tools) || b.tools.length !== 0)) ||
        (b.tool_choice !== undefined && b.tool_choice !== 'none') ||
        b.store === true ||
        b.stream === true ||
        JSON.stringify(b.text) !==
          JSON.stringify({
            format: {
              type: 'json_schema',
              name: 'theme_changes',
              strict: true,
              schema: changesSchema(l.task),
            },
          })
      )
        return deny('tools_input_or_storage_denied', 422);
      l.used = true; // Before network: failure, abort, timeout or ambiguity never retries.
      const timeout = AbortSignal.any([
        signal,
        AbortSignal.timeout(Math.max(1, l.expires - Date.now())),
      ]);
      timeout.throwIfAborted();
      const payload = {
        model: this.model,
        input: b.input,
        tools: [],
        tool_choice: 'none',
        store: false,
        stream: false,
        max_output_tokens: s.max_output_tokens,
        text: {
          format: {
            type: 'json_schema',
            name: 'theme_changes',
            strict: true,
            schema: changesSchema(l.task),
          },
        },
      };
      const upstream = await this.transport(this.upstream, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + this.upstreamKey,
        },
        body: JSON.stringify(payload),
        redirect: 'error',
        signal: timeout,
      });
      if (!upstream.ok) return deny('provider_failure', 502);
      const value = await boundedJson(upstream, 64000, timeout);
      responseChanges(value, l.task); // Refusal, incomplete, tool calls, bad usage/path/schema fail closed.
      return Response.json(value, { headers: { 'Cache-Control': 'no-store' } });
    } catch {
      return deny('gateway_failure', 502);
    }
  }
}
