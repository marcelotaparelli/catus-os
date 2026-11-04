// Verification only (temporary branch, never merged): the real Docker stack over HTTPS.
import { chromium, firefox, webkit } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
const BASE = 'https://localhost:3443', CA = '.local/compose/tls/ca.crt', OUT = 'font-evidence';
mkdirSync(OUT, { recursive: true });
const sha = (b) => createHash('sha256').update(b).digest('hex');
// curl with the install's own CA: TLS is really validated here.
function get(path, name) {
  const body = `${OUT}/${name}`, head = `${OUT}/${name}.headers`;
  execFileSync('curl', ['-sS', '--fail', '--cacert', CA, '-D', head, '-o', body, BASE + path]);
  const headers = Object.fromEntries(readFileSync(head, 'utf8').split('\r\n').filter((l) => l.includes(':')).map((l) => { const i = l.indexOf(':'); return [l.slice(0, i).toLowerCase(), l.slice(i + 1).trim()]; }));
  return { headers, bytes: readFileSync(body) };
}
const index = get('/', 'index.html');
const csp = index.headers['content-security-policy'];
const css = [...index.bytes.toString().matchAll(/href="(\/assets\/[^"]+\.css)"/g)].map((m) => m[1]);
const fontUrls = new Set();
for (const c of css) for (const m of get(c, 'style.css').bytes.toString().matchAll(/url\(([^)]*?)\)/g)) { const u = m[1].replace(/['"]/g, ''); if (/woff2/.test(u)) fontUrls.add(u); }
const sources = readdirSync('src/web/fonts').filter((f) => f.endsWith('.woff2')).map((f) => sha(readFileSync(`src/web/fonts/${f}`)));
const fonts = [...fontUrls].map((u, i) => {
  const r = get(u, `font-${i}`);
  return { url: u, status: 200, content_type: r.headers['content-type'], nosniff: r.headers['x-content-type-options'], cache: r.headers['cache-control'], csp_header: r.headers['content-security-policy'] === csp, bytes: r.bytes.length, signature: r.bytes.subarray(0, 4).toString('latin1'), same_bytes_as_source: sources.includes(sha(r.bytes)) };
});
const browsers = {};
let ok = fonts.length === 2 && fonts.every((f) => f.signature === 'wOF2' && f.same_bytes_as_source);
for (const [name, type] of Object.entries({ chromium, firefox, webkit })) {
  const b = await type.launch();
  const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const console_ = [], responses = [], failed = [];
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) console_.push(m.text()); });
  page.on('response', (r) => { if (/woff2/.test(r.url())) responses.push({ url: new URL(r.url()).pathname, status: r.status(), type: r.headers()['content-type'] }); });
  page.on('requestfailed', (r) => failed.push(r.url()));
  await page.addInitScript(() => { window.__csp = []; addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`)); });
  await page.goto(BASE + '/');
  await page.waitForLoadState('networkidle');
  const r = await page.evaluate(async () => {
    await document.fonts.ready;
    const loaded = {};
    for (const f of ['400 16px Inter', '400 16px Lexend']) loaded[f] = (await document.fonts.load(f)).map((x) => x.status);
    return { loaded, faces: [...document.fonts].map((f) => `${f.family} ${f.weight} ${f.status}`), used: getComputedStyle(document.body).fontFamily, heading: getComputedStyle(document.querySelector('h1') ?? document.body).fontFamily, csp: window.__csp };
  });
  // Page messages are read before the screenshot: Playwright injects its own <style> to take it.
  const beforeShot = [...console_];
  const fine = Object.values(r.loaded).every((l) => l.length > 0 && l.every((s) => s === 'loaded')) && !r.csp.length && !failed.length && !beforeShot.some((t) => /font|style|Content.Security|MIME|OTS/i.test(t));
  await page.screenshot({ path: `${OUT}/${name}.png` });
  browsers[name] = { version: b.version(), ok: fine, ...r, responses, failed, console_before_screenshot: beforeShot, console_after_screenshot: console_.slice(beforeShot.length) };
  ok &&= fine;
  await b.close();
}
const report = { csp, css, fonts, browsers, ok };
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, '```json\n' + JSON.stringify(report, null, 2) + '\n```\n');
process.exit(ok ? 0 : 1);
