import { resolve } from 'node:path';
import type { AppConfig } from './config';
const root = resolve('dist');
export function webHandler(
  api: (request: Request, peer?: string) => Promise<Response>,
  config: AppConfig,
) {
  return async (request: Request, peer: string) => {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/api/')) return api(request, peer);
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return new Response(null, { status: 405 });
    const file =
      path === '/'
        ? 'index.html'
        : /^\/assets\/[a-zA-Z0-9._-]+\.(js|css)$/.test(path)
          ? path.slice(1)
          : undefined;
    if (!file) return new Response(null, { status: 404 });
    const asset = Bun.file(resolve(root, file));
    if (!(await asset.exists()))
      return new Response('Run npm run build', { status: 503 });
    return new Response(request.method === 'HEAD' ? null : asset, {
      headers: {
        'Content-Type': file.endsWith('.js')
          ? 'text/javascript'
          : file.endsWith('.css')
            ? 'text/css'
            : 'text/html; charset=utf-8',
        'Cache-Control':
          path === '/' ? 'no-store' : 'public, max-age=86400, immutable',
        'Content-Security-Policy':
          "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
        ...(config.secureCookies
          ? { 'Strict-Transport-Security': 'max-age=300' }
          : {}),
      },
    });
  };
}
