// Test executable only; production entrypoint never imports this file or the simulated provider.
if (process.env.NODE_ENV !== 'test')
  throw new Error('Test harness requires NODE_ENV=test');
await import('../setup');
const { pool } = await import('../../src/server/db');
const { createApp } = await import('../../src/server/app');
const { oidcProvider } = await import('../../src/server/auth/oidc');
const { config, mockOidcFetch } = await import('./oidc-provider');
await pool.query(
  'TRUNCATE audit_events,sessions,oidc_transactions,requests,interactions,projects,clients,memberships,users,organizations CASCADE',
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
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 3000,
  fetch: createApp(config, oidcProvider(config, await mockOidcFetch())),
  maxRequestBodySize: 32768,
});
console.log('Test-only OIDC harness ready');
async function stop() {
  await server.stop();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    for (const table of [
      'audit_events',
      'sessions',
      'requests',
      'interactions',
      'projects',
      'clients',
      'memberships',
    ])
      await c.query(
        `DELETE FROM ${table} WHERE organization_id=ANY($1::uuid[])`,
        [[org, orgB]],
      );
    await c.query(
      "DELETE FROM users WHERE issuer=$1 AND email IN ('po@browser.test','dev@browser.test','outsider@browser.test')",
      [config.oidc!.issuer],
    );
    await c.query('DELETE FROM organizations WHERE id=ANY($1::uuid[])', [
      [org, orgB],
    ]);
    await c.query('COMMIT');
  } finally {
    c.release();
    await pool.end();
  }
  process.exit(0);
}
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => void stop());

export {};
