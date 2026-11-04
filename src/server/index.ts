import { createApp } from './app';
import { pool } from './db';
import { loadConfig } from './config';
import { webHandler } from './http';
import { assertRuntimePrivileges } from '../../scripts/lib/privileges';
import { startFollowupAutomation } from './followup/automation';
if (
  !process.env.RUNTIME_DATABASE_URL ||
  process.env.DATABASE_URL ||
  process.env.MIGRATION_DATABASE_URL ||
  process.env.MAINTENANCE_DATABASE_URL
)
  throw new Error(
    'Use the isolated runtime launcher, without administrative/migration credentials',
  );
const config = loadConfig();
const port = Number(process.env.PORT ?? (config.secureCookies ? 3443 : 3000));
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('Invalid PORT');
const cert = process.env.TLS_CERT_FILE,
  key = process.env.TLS_KEY_FILE;
if (config.secureCookies && (!cert || !key))
  throw new Error(
    'HTTPS origin requires TLS_CERT_FILE and TLS_KEY_FILE; no implicit proxy trust',
  );
if (!config.secureCookies && (cert || key))
  throw new Error('TLS files require an HTTPS APP_ORIGIN');
await assertRuntimePrivileges(pool);
// Deterministic and local: no external service. FOLLOWUP_AUTOMATION=off stops only the alerts.
const stopAutomation =
  process.env.FOLLOWUP_AUTOMATION === 'off'
    ? () => undefined
    : startFollowupAutomation(pool);
const handler = webHandler(createApp(config), config);
const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  ...(cert && key ? { tls: { cert: Bun.file(cert), key: Bun.file(key) } } : {}),
  fetch: (request, server) =>
    handler(request, server.requestIP(request)?.address ?? 'unknown'),
  maxRequestBodySize: 32768,
});
console.log(
  `Catus listening on loopback port ${server.port}; TLS ${config.secureCookies ? 'enabled' : 'disabled'}`,
);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, async () => {
    stopAutomation();
    await server.stop();
    await pool.end();
    process.exit(0);
  });
