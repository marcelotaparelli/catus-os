// Test executable: the real production static handler with a stub API, so a browser
// can prove that fonts and logo work under the server's own allowlist and CSP.
import { webHandler } from '../../src/server/http';
import type { AppConfig } from '../../src/server/config';

const handler = webHandler(
  async (request) =>
    new URL(request.url).pathname === '/api/auth/config'
      ? Response.json({ configured: true })
      : Response.json({ error: 'Sessão ausente' }, { status: 401 }),
  { secureCookies: false } as AppConfig,
);
Bun.serve({
  port: Number(process.env.STATIC_PORT ?? 4175),
  hostname: '127.0.0.1',
  fetch: (request) => handler(request, '127.0.0.1'),
});
