import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { webHandler } from '../src/server/http';
import type { AppConfig } from '../src/server/config';

// The static handler only serves /assets/*.js, *.css and *.woff2. A font emitted under
// any other name works in `vite dev` and 404s in production, so check the real handler.
const handler = webHandler(async () => new Response(null, { status: 404 }), {
  secureCookies: false,
} as AppConfig);
const get = (path: string) =>
  handler(new Request('http://x' + path), '127.0.0.1');

describe.skipIf(!existsSync('dist/index.html'))('built web assets', () => {
  const html = existsSync('dist/index.html')
    ? readFileSync('dist/index.html', 'utf8')
    : '';
  const css = () =>
    readdirSync('dist/assets')
      .filter((f) => f.endsWith('.css'))
      .map((f) => readFileSync('dist/assets/' + f, 'utf8'))
      .join('');

  test('every font the stylesheet asks for is served, as WOFF2 bytes', async () => {
    const urls = [...css().matchAll(/url\((\/assets\/[^)]+)\)/g)].map(
      (m) => m[1]!,
    );
    expect(urls.length).toBe(2);
    for (const url of urls) {
      const res = await get(url);
      expect(res.status).toBe(200);
      const head = new Uint8Array(await res.arrayBuffer()).slice(0, 4);
      expect(new TextDecoder().decode(head)).toBe('wOF2');
      expect(res.headers.get('content-type')).toBe('font/woff2');
      expect(html).toContain(url);
    }
  });

  test('nothing in the build depends on a file the server refuses', () => {
    for (const file of readdirSync('dist/assets'))
      expect(file).toMatch(/^[a-zA-Z0-9._-]+\.(js|css|woff2)$/);
    expect(css()).not.toContain('url(data:font');
  });

  test('the logo ships inside the page and without inline style', () => {
    expect(html).toContain('id="catus-logo"');
    expect(html).not.toContain('style=');
  });
});
