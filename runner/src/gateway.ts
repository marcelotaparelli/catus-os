import { randomBytes, createHash } from 'node:crypto';
import type { DeliveryTask } from '../../src/shared/delivery.ts';
import type { GatewayLease } from './codex-agent.ts';
export class CappedGateway {
  private leases = new Map<
    string,
    { task: DeliveryTask; used: boolean; expires: number }
  >();
  private master: string;
  private upstreamKey: string;
  private upstream: string;
  private model: string;
  private transport: (
    url: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
  constructor(
    master: string,
    upstreamKey: string,
    upstream: string,
    model: string,
    transport: (
      url: string | URL | Request,
      init?: RequestInit,
    ) => Promise<Response> = fetch,
  ) {
    this.master = master;
    this.upstreamKey = upstreamKey;
    this.upstream = upstream;
    this.model = model;
    this.transport = transport;
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
    try {
      const path = new URL(request.url).pathname,
        token = request.headers.get('authorization')?.replace(/^Bearer /, '');
      if (request.method !== 'POST')
        return Response.json({ error: 'method_denied' }, { status: 405 });
      const raw = await request.arrayBuffer();
      if (raw.byteLength > 128000)
        return Response.json({ error: 'input_limit' }, { status: 413 });
      const b = JSON.parse(Buffer.from(raw).toString('utf8'));
      if (path === '/allocate') {
        if (token !== this.master)
          return Response.json({ error: 'denied' }, { status: 401 });
        const task = b as DeliveryTask;
        if (
          !task.job_id ||
          task.settings.harness !== 'codex-sdk' ||
          !Number.isInteger(task.settings.max_input_tokens) ||
          task.settings.max_input_tokens < 1000 ||
          task.settings.max_input_tokens > 32000 ||
          !Number.isInteger(task.settings.max_output_tokens) ||
          task.settings.max_output_tokens < 128 ||
          task.settings.max_output_tokens > 4096
        )
          throw new Error('limits');
        // A job cannot obtain a second call token, even after expiry/close or an ambiguous provider failure.
        if (
          [...this.leases.values()].some((v) => v.task.job_id === task.job_id)
        )
          return Response.json({ error: 'already_allocated' }, { status: 409 });
        const credential = randomBytes(32).toString('base64url');
        this.leases.set(this.hash(credential), {
          task,
          used: false,
          expires: Date.now() + task.settings.timeout_seconds * 1000,
        });
        const lease: GatewayLease = {
          url: 'http://delivery-gateway:8080/v1',
          token: credential,
          max_input_tokens: task.settings.max_input_tokens,
          max_output_tokens: task.settings.max_output_tokens,
          max_requests: 1,
          job_budget_micro_usd: task.settings.job_budget_micro_usd,
        };
        return Response.json(lease);
      }
      if (path === '/close') {
        if (token !== this.master)
          return Response.json({ error: 'denied' }, { status: 401 });
        for (const l of this.leases.values())
          if (l.task.job_id === b.job_id) l.used = true;
        return Response.json({ closed: true });
      }
      if (path !== '/v1/responses')
        return Response.json({ error: 'route_denied' }, { status: 404 });
      const lease = token ? this.leases.get(this.hash(token)) : undefined;
      if (!lease || lease.used || Date.now() > lease.expires)
        return Response.json({ error: 'budget_denied' }, { status: 429 });
      const settings = lease.task.settings;
      if (
        raw.byteLength + 2048 > settings.max_input_tokens ||
        (Array.isArray(b.tools) && b.tools.length) ||
        b.previous_response_id ||
        b.store === true
      )
        return Response.json(
          { error: 'tools_input_or_storage_denied' },
          { status: 422 },
        );
      const money =
        (BigInt(settings.max_input_tokens) *
          BigInt(settings.input_micro_usd_per_million) +
          BigInt(settings.max_output_tokens) *
            BigInt(settings.output_micro_usd_per_million) +
          999999n) /
        1000000n;
      if (money > BigInt(settings.job_budget_micro_usd))
        return Response.json({ error: 'budget_denied' }, { status: 429 });
      lease.used = true; // Reserve before network. Never retry a charged/ambiguous call.
      const payload = {
        ...b,
        model: this.model,
        max_output_tokens: settings.max_output_tokens,
        tools: [],
        store: false,
        stream: false,
      };
      const upstream = await this.transport(this.upstream, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + this.upstreamKey,
        },
        body: JSON.stringify(payload),
        redirect: 'error',
        signal: AbortSignal.timeout(
          Math.min(settings.timeout_seconds * 1000, 120000),
        ),
      });
      if (!upstream.ok)
        return Response.json({ error: 'provider_failure' }, { status: 502 });
      const reader = upstream.body?.getReader();
      if (!reader) throw new Error('body');
      let bytes = 0;
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 64000) {
            await reader.cancel();
            throw new Error('response_limit');
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
      const text = Buffer.concat(chunks).toString('utf8'),
        value = JSON.parse(text);
      if (
        !Array.isArray(value.output) ||
        value.output.some(
          (o: { type: string }) => !['message', 'reasoning'].includes(o.type),
        )
      )
        throw new Error('tools_denied');
      if (
        value.usage &&
        (Number(value.usage.input_tokens) > settings.max_input_tokens ||
          Number(value.usage.output_tokens) > settings.max_output_tokens)
      )
        throw new Error('usage_limit');
      if (b.stream === true) {
        const events: string[] = [];
        let sequence = 0;
        const emit = (type: string, data: Record<string, unknown>) =>
          events.push(
            'event: ' +
              type +
              '\ndata: ' +
              JSON.stringify({ type, sequence_number: sequence++, ...data }) +
              '\n\n',
          );
        emit('response.created', {
          response: { ...value, status: 'in_progress', output: [] },
        });
        for (const [index, item] of value.output.entries()) {
          emit('response.output_item.added', {
            output_index: index,
            item: {
              ...item,
              content: item.type === 'message' ? [] : item.content,
            },
          });
          if (item.type === 'message')
            for (const [partIndex, part] of (item.content ?? []).entries()) {
              if (part.type !== 'output_text')
                throw new Error('unsupported_output');
              const ids = {
                item_id: item.id,
                output_index: index,
                content_index: partIndex,
              };
              emit('response.content_part.added', {
                ...ids,
                part: { ...part, text: '' },
              });
              emit('response.output_text.delta', { ...ids, delta: part.text });
              emit('response.output_text.done', { ...ids, text: part.text });
              emit('response.content_part.done', { ...ids, part });
            }
          emit('response.output_item.done', { output_index: index, item });
        }
        emit('response.completed', { response: value });
        return new Response(events.join(''), {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-store',
          },
        });
      }
      return Response.json(value, { headers: { 'Cache-Control': 'no-store' } });
    } catch {
      return Response.json({ error: 'gateway_failure' }, { status: 502 });
    }
  }
}
