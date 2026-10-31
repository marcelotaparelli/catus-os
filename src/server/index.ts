import { createApp } from './app';
import { pool } from './db';
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('Invalid PORT');
const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  fetch: createApp(),
  maxRequestBodySize: 32768,
});
console.log(`Catus API listening on loopback port ${server.port}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, async () => {
    await server.stop();
    await pool.end();
    process.exit(0);
  });
