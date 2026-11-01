import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
export function gatewayEnvironment(base) {
  const names = [
    'PATH',
    'HOME',
    'LANG',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'SSL_CERT_FILE',
    'NODE_EXTRA_CA_CERTS',
    'CODEX_GATEWAY_CONTROL_TOKEN',
    'CODEX_UPSTREAM_KEY',
    'CODEX_UPSTREAM_RESPONSES_URL',
    'CODEX_MODEL',
    'CODEX_GATEWAY_BIND',
    'CODEX_GATEWAY_CONTAINER_ONLY',
  ];
  return Object.fromEntries(
    names.filter((k) => typeof base[k] === 'string').map((k) => [k, base[k]]),
  );
}
export function runnerEnvironment(base) {
  const allowed = [
    'PATH',
    'HOME',
    'LANG',
    'TMPDIR',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'SSL_CERT_FILE',
    'NODE_EXTRA_CA_CERTS',
    'DOCKER_CONFIG',
    'DELIVERY_API_URL',
    'DELIVERY_RUNNER_TOKEN',
    'DELIVERY_RUNNER_REPOS_FILE',
    'DELIVERY_CODEX_NETWORK',
    'DELIVERY_CODEX_IMAGE',
    'CODEX_GATEWAY_CONTROL_URL',
    'CODEX_GATEWAY_CONTROL_TOKEN',
    'CODEX_MODEL',
  ];
  return Object.fromEntries(
    allowed.filter((k) => typeof base[k] === 'string').map((k) => [k, base[k]]),
  );
}
if (
  import.meta.url === new URL('file://' + resolve(process.argv[1] ?? '')).href
) {
  const gateway = process.argv.includes('--gateway');
  const child = spawn(
    gateway ? resolve('node_modules/.bin/bun') : process.execPath,
    [
      ...(gateway
        ? ['--no-env-file', 'runner/src/gateway-server.ts']
        : ['--experimental-strip-types', 'runner/src/main.ts']),
      ...(process.argv.includes('--once') ? ['--once'] : []),
    ],
    {
      env: gateway
        ? gatewayEnvironment(process.env)
        : runnerEnvironment(process.env),
      stdio: 'inherit',
    },
  );
  for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => child.kill(s));
  child.on('exit', (c) => process.exit(c ?? 1));
}
