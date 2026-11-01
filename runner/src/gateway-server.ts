import { CappedGateway } from './gateway.ts';
const required = [
  'CODEX_GATEWAY_CONTROL_TOKEN',
  'CODEX_UPSTREAM_KEY',
  'CODEX_UPSTREAM_RESPONSES_URL',
  'CODEX_MODEL',
] as const;
if (required.some((n) => !process.env[n]))
  throw new Error(
    'Gateway unavailable: explicit legitimate credentials/model/upstream required',
  );
const bind = process.env.CODEX_GATEWAY_BIND ?? '127.0.0.1';
if (
  bind !== '127.0.0.1' &&
  !(bind === '0.0.0.0' && process.env.CODEX_GATEWAY_CONTAINER_ONLY === 'true')
)
  throw new Error(
    'Gateway must use loopback or an unpublished isolated container',
  );
const gateway = new CappedGateway(
  process.env.CODEX_GATEWAY_CONTROL_TOKEN!,
  process.env.CODEX_UPSTREAM_KEY!,
  process.env.CODEX_UPSTREAM_RESPONSES_URL!,
  process.env.CODEX_MODEL!,
);
Bun.serve({
  hostname: bind,
  port: 8080,
  maxRequestBodySize: 128000,
  fetch: (r) => gateway.handle(r),
});
console.log('Capped gateway ready; no key/provider output logged');
