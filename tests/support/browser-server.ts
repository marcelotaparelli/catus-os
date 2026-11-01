// Test executable only; production entrypoint never imports this file or the simulated provider.
if (process.env.NODE_ENV !== 'test')
  throw new Error('Test harness requires NODE_ENV=test');
await import('../setup');
const { pool } = await import('../../src/server/db');
const { createApp } = await import('../../src/server/app');
const { oidcProvider } = await import('../../src/server/auth/oidc');
const { config, mockOidcFetch } = await import('./oidc-provider');
await pool.query(
  'TRUNCATE rate_limits,idempotency_keys,audit_events,sessions,oidc_transactions,requests,interactions,projects,clients,memberships,users,organizations CASCADE',
);
const org = crypto.randomUUID(),
  orgB = crypto.randomUUID();
await pool.query('INSERT INTO organizations(id,name) VALUES($1,$2),($3,$4)', [
  org,
  'Browser Catus',
  orgB,
  'Browser Other',
]);
for (const [email, name, role, organization] of [
  ['po@browser.test', 'PO Browser', 'po', org],
  ['dev@browser.test', 'Dev Browser', 'developer', org],
  ['manager@browser.test', 'Gestor Browser', 'manager', org],
  ['admin@browser.test', 'Admin Browser', 'administrator', org],
  ['outsider@browser.test', 'Other Browser', 'po', orgB],
]) {
  const id = crypto.randomUUID();
  await pool.query(
    'INSERT INTO users(id,issuer,email,display_name) VALUES($1,$2,$3,$4)',
    [id, config.oidc!.issuer, email, name],
  );
  await pool.query(
    'INSERT INTO memberships(user_id,organization_id,role) VALUES($1,$2,$3)',
    [id, organization, role],
  );
}
const { fixtureProvider } = await import('./extraction-fixture');
const { processOne } = await import('../../src/server/ai/worker');
const {
  fixtureRepository,
  fixtureAgent,
  themeIntakeSource,
  themeIntakeFixture,
} = await import('./delivery-fixture');
const { runnerCycle } = await import('../../runner/src/core');
const { createHash, randomBytes } = await import('node:crypto');
const deliveryFixture = await fixtureRepository();
const baseExtractor = fixtureProvider(),
  themeExtractor = fixtureProvider(() => themeIntakeFixture());
const extractor = {
  config: baseExtractor.config,
  extract: (source: string) =>
    source === themeIntakeSource
      ? themeExtractor.extract(source)
      : baseExtractor.extract(source),
};
const initiator = (
  await pool.query("SELECT id FROM users WHERE email='po@browser.test'")
).rows[0].id;
await pool.query(
  "INSERT INTO ai_policies(organization_id,enabled,policy_reference,data_scope,daily_budget_micro_usd,per_job_budget_micro_usd,daily_job_limit,updated_by) VALUES($1,true,'E2E-SYNTHETIC-ONLY','synthetic',1000000,100000,20,$2)",
  [org, initiator],
);
let processing: Promise<boolean> | undefined;
const aiTimer = setInterval(() => {
  if (!processing)
    processing = processOne(pool, extractor).finally(
      () => (processing = undefined),
    );
}, 50);
const handler = createApp(config, oidcProvider(config, await mockOidcFetch()), {
  extractionProvider: extractor,
  delivery: deliveryFixture.config,
  // Browser suites share one loopback peer and exercise multiple users per minute.
  // Production limits remain unchanged and have dedicated negative integration tests.
  loginRate: { limit: 200, windowSeconds: 60 },
  apiRate: { limit: 2000, windowSeconds: 60 },
});
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 3000,
  fetch: (req, server) =>
    handler(req, server.requestIP(req)?.address ?? 'unknown'),
  maxRequestBodySize: 32768,
});
let delivering: Promise<void> | undefined;
const deliveryTokens = new Map<string, string>();
const deliveryTimer = setInterval(() => {
  if (delivering) return;
  delivering = (async () => {
    const policies = (
      await pool.query(
        'SELECT organization_id,project_id FROM delivery_policies WHERE enabled',
      )
    ).rows;
    for (const p of policies) {
      let token = deliveryTokens.get(p.project_id);
      if (!token) {
        token = randomBytes(32).toString('base64url');
        deliveryTokens.set(p.project_id, token);
        await pool.query(
          "INSERT INTO delivery_runners(id,organization_id,project_id,token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')",
          [
            crypto.randomUUID(),
            p.organization_id,
            p.project_id,
            createHash('sha256').update(token).digest('hex'),
          ],
        );
      }
      const call = async (path: string, body: unknown) => {
        const r = await handler(
          new Request(config.origin + '/api/delivery-runner/' + path, {
            method: 'POST',
            headers: {
              Authorization: 'Bearer ' + token,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
          }),
          'delivery-test-fixture',
        );
        if (!r.ok) throw new Error('Test delivery broker rejected operation');
        return r.json();
      };
      await runnerCycle(
        {
          claim: () => call('claim', {}),
          post: (id, action, b) => call('jobs/' + id + '/' + action, b),
        },
        [deliveryFixture.repo],
        fixtureAgent,
      );
    }
  })()
    .catch(() => console.error('Test delivery fixture cycle failed'))
    .finally(() => (delivering = undefined));
}, 100);
console.log('Test-only OIDC harness ready');
async function stop() {
  clearInterval(aiTimer);
  clearInterval(deliveryTimer);
  await delivering;
  await deliveryFixture.cleanup();
  await processing;
  await server.stop();
  await pool.query(
    'TRUNCATE rate_limits,idempotency_keys,audit_events,sessions,oidc_transactions,requests,interactions,projects,clients,memberships,users,organizations CASCADE',
  );
  await pool.end();
  process.exit(0);
}
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => void stop());
export {};
