import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { webHandler } from '../src/server/http';
import type { AppConfig } from '../src/server/config';

const handler = webHandler(async () => new Response(null, { status: 404 }), {
  secureCookies: true,
} as AppConfig);
const get = (path: string) =>
  handler(new Request('https://x' + path), '127.0.0.1');
const font = 'dist/assets/probe-static-assets.woff2';
const bytes = new TextEncoder().encode('wOF2 synthetic probe');

beforeAll(() => {
  mkdirSync('dist/assets', { recursive: true });
  writeFileSync(font, bytes);
});
afterAll(() => rmSync(font));

test('a WOFF2 is served with its own MIME and the same protections', async () => {
  const res = await get('/assets/probe-static-assets.woff2');
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('font/woff2');
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(res.headers.get('content-security-policy')).toContain(
    "default-src 'self'",
  );
  expect(res.headers.get('cache-control')).toContain('immutable');
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
});
test('HEAD carries the MIME without a body', async () => {
  const res = await handler(
    new Request('https://x/assets/probe-static-assets.woff2', {
      method: 'HEAD',
    }),
    '127.0.0.1',
  );
  expect(res.headers.get('content-type')).toBe('font/woff2');
  expect(await res.text()).toBe('');
});
test('the allowlist stays closed: other types, other folders and traversal', async () => {
  for (const path of [
    '/assets/probe-static-assets.ttf',
    '/assets/probe-static-assets.woff',
    '/assets/probe-static-assets.woff2.map',
    '/probe-static-assets.woff2',
    '/assets/../assets/probe-static-assets.woff2x',
    '/assets/%2e%2e%2f.env.woff2',
    '/assets/sub/probe.woff2',
  ])
    expect([404, 503]).toContain((await get(path)).status);
  expect((await get('/assets/%2e%2e%2f.env.woff2')).status).toBe(404);
});
test('a missing font never falls through to another file', async () => {
  expect((await get('/assets/absent.woff2')).status).toBe(503);
});
