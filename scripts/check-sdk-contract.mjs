// No provider: actual pinned SDK/CLI speaks only to this loopback rejection server.
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { Codex } from '../runner/node_modules/@openai/codex-sdk/dist/index.js';
const home = await mkdtemp(join(tmpdir(), 'catus-sdk-contract-'));
const captured = [];
const server = createServer(async (req, res) => {
  let body = '';
  for await (const part of req) {
    body += part;
    if (body.length > 128000) {
      req.destroy();
      return;
    }
  }
  try {
    const b = JSON.parse(body);
    captured.push({
      path: req.url,
      tools: (b.tools ?? []).map((t) => t.name ?? t.type),
      stream: b.stream,
      structured: b.text?.format?.type,
    });
  } catch {}
  res.writeHead(422, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'tools_input_or_storage_denied' }));
});
try {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const sdk = new Codex({
    apiKey: 'synthetic-invalid-no-provider',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home },
    config: {
      features: { shell_tool: false, apply_patch_freeform: false },
      disable_response_storage: true,
      otel: { exporter: 'none', trace_exporter: 'none' },
    },
  });
  try {
    await sdk
      .startThread({
        workingDirectory: home,
        skipGitRepoCheck: true,
        sandboxMode: 'read-only',
        approvalPolicy: 'never',
        networkAccessEnabled: false,
        webSearchMode: 'disabled',
        model: 'gpt-5.3-codex',
      })
      .run('Synthetic contract probe. Return JSON only. Do not use tools.', {
        outputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: { files: { type: 'array', items: { type: 'string' } } },
          required: ['files'],
        },
        signal: AbortSignal.timeout(20000),
      });
  } catch {}
  assert.ok(
    captured.length > 0,
    'NOT_VERIFIED: CLI did not reach loopback; no incompatibility proven',
  );
  assert.ok(
    captured.some((r) => r.tools.length > 0),
    'Contract changed: re-audit SDK compatibility',
  );
  assert.ok(captured.every((r) => r.path === '/v1/responses'));
  console.log(
    JSON.stringify({
      sdk: '0.166.0',
      result: 'INCOMPATIBLE_NO_TOOLS',
      requests: captured,
      provider_calls: 0,
    }),
  );
} finally {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await rm(home, { recursive: true, force: true });
}
