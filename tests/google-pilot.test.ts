/**
 * G3 regressions without Google credentials: client import validation, offline
 * first-administrator bootstrap and login of consumer (non-Workspace) accounts,
 * which stays restricted to previously provisioned identities.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/app';
import pg from 'pg';
import { oidcProvider } from '../src/server/auth/oidc';
import { cookieName } from '../src/server/auth/cookies';
import {
  config as workspace,
  mockOidcFetch,
  codeFor,
} from './support/oidc-provider';
import {
  oidcEnvFile,
  parseGoogleClientJson,
  validateGoogleClient,
} from '../scripts/lib/google-client';

const origin = 'https://localhost:3443';
const id =
  '123456789012-abcdefghijklmnopqrstuvwxyzabcdef.apps.googleusercontent.com';
const secret = 'GOCSPX-synthetic-not-a-real-secret';
const web = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    web: {
      client_id: id,
      client_secret: secret,
      auth_uri: 'https://accounts.google.com/o/oauth2/auth',
      token_uri: 'https://oauth2.googleapis.com/token',
      redirect_uris: [`${origin}/api/auth/callback`],
      ...extra,
    },
  });

describe('G3: Google client import', () => {
  test('accepts a Web client JSON and the manual form, optional Workspace domain', () => {
    expect(parseGoogleClientJson(web(), origin)).toEqual({
      clientId: id,
      clientSecret: secret,
    });
    expect(parseGoogleClientJson(web(), origin, ' Catus.Example ')).toEqual({
      clientId: id,
      clientSecret: secret,
      hostedDomain: 'catus.example',
    });
    expect(
      validateGoogleClient({
        clientId: ` ${id} `,
        clientSecret: secret,
        hostedDomain: '',
      }),
    ).toEqual({ clientId: id, clientSecret: secret });
    expect(oidcEnvFile({ clientId: id, clientSecret: secret })).toBe(
      `OIDC_ISSUER=https://accounts.google.com\nOIDC_CLIENT_ID=${id}\n`,
    );
    expect(
      oidcEnvFile({
        clientId: id,
        clientSecret: secret,
        hostedDomain: 'catus.example',
      }),
    ).toContain('OIDC_HOSTED_DOMAIN=catus.example\n');
    expect(oidcEnvFile({ clientId: id, clientSecret: secret })).not.toContain(
      secret,
    );
  });

  test('rejects wrong client type, redirect URI, malformed values and consumer hd', () => {
    const bad: [string, string?][] = [
      ['not json'],
      [JSON.stringify({ installed: { client_id: id, client_secret: secret } })],
      [web({ redirect_uris: ['http://localhost:3443/api/auth/callback'] })],
      [web({ redirect_uris: ['https://localhost:3006/api/auth/callback'] })],
      [web({ client_id: 'catus-client' })],
      [web({ client_secret: '' })],
      [web({ client_secret: 'has space inside' })],
      [web({ auth_uri: 'https://evil.example/o/oauth2/auth' })],
      [web(), 'gmail.com'],
      [web(), 'not a domain'],
    ];
    for (const [json, hd] of bad) {
      let message = '';
      try {
        parseGoogleClientJson(json, origin, hd);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).not.toBe('');
      expect(message).not.toContain(secret);
    }
    expect(() =>
      validateGoogleClient({ clientId: id, clientSecret: `${secret}\nextra` }),
    ).toThrow();
  });

  test('setup CLI writes 0600 files, never prints the secret, fails closed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'catus-oidc-'));
    try {
      const run = async (stdin: string, env: Record<string, string> = {}) => {
        const child = Bun.spawn(
          ['node_modules/.bin/bun', 'scripts/google-client-setup.ts'],
          {
            env: {
              PATH: process.env.PATH!,
              APP_ORIGIN: origin,
              OIDC_OUTPUT_DIR: dir,
              OIDC_CLIENT_JSON: join(dir, 'absent.json'),
              ...env,
            },
            stdin: new Blob([stdin]),
            stdout: 'pipe',
            stderr: 'pipe',
          },
        );
        const out =
          (await new Response(child.stdout).text()) +
          (await new Response(child.stderr).text());
        return { code: await child.exited, out };
      };
      const bad = await run(`catus-client\n${secret}\n\n`);
      expect(bad.code).toBe(2);
      expect(bad.out).not.toContain(secret);
      expect(() => statSync(join(dir, 'oidc_client_secret'))).toThrow();
      const ok = await run(`${id}\n${secret}\n\n`);
      expect(ok.code).toBe(0);
      expect(ok.out).not.toContain(secret);
      expect(ok.out).toContain(`${origin}/api/auth/callback`);
      for (const f of ['oidc_client_secret', 'oidc.env'])
        expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(dir, 'oidc_client_secret'), 'utf8')).toBe(
        secret,
      );
      expect(readFileSync(join(dir, 'oidc.env'), 'utf8')).not.toContain(secret);
      const http = await run('', { APP_ORIGIN: 'http://localhost:3443' });
      expect(http.code).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('G3: first administrator and consumer Google accounts', () => {
  const org = crypto.randomUUID();
  const consumer = {
    ...workspace,
    oidc: { ...workspace.oidc!, hostedDomain: undefined },
  };
  let fetcher: Awaited<ReturnType<typeof mockOidcFetch>>;
  // Own pool: other test files end the shared pool when the suite runs in one process.
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const cleanup = async () => {
    await pool.query(
      "DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@gmail.test')",
    );
    await pool.query('DELETE FROM audit_events WHERE organization_id=$1', [
      org,
    ]);
    await pool.query('DELETE FROM memberships WHERE organization_id=$1', [org]);
    await pool.query("DELETE FROM users WHERE email LIKE '%@gmail.test'");
    await pool.query('DELETE FROM organizations WHERE id=$1', [org]);
  };
  beforeAll(async () => {
    fetcher = await mockOidcFetch();
    await cleanup();
    await pool.query('INSERT INTO organizations(id,name) VALUES($1,$2)', [
      org,
      'G3 pilot',
    ]);
  });
  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  const bootstrap = async (env: Record<string, string>, email: string) => {
    const child = Bun.spawn(
      [
        'node_modules/.bin/bun',
        'scripts/bootstrap-admin.ts',
        '--email',
        email,
        '--name',
        'Administradora Piloto',
        '--organization',
        org,
      ],
      {
        env: {
          PATH: process.env.PATH!,
          MIGRATION_DATABASE_URL: process.env.DATABASE_URL!,
          ...env,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const out =
      (await new Response(child.stdout).text()) +
      (await new Response(child.stderr).text());
    return { code: await child.exited, out };
  };
  const oidcEnv = {
    OIDC_ISSUER: workspace.oidc!.issuer,
    OIDC_CLIENT_ID: workspace.oidc!.clientId,
    OIDC_CLIENT_SECRET: workspace.oidc!.clientSecret,
  };
  async function login(
    app: ReturnType<typeof createApp>,
    email: string,
    failure?: 'consumer',
  ) {
    const start = await app(new Request(`${consumer.origin}/api/auth/login`));
    expect(start.status).toBe(303);
    const auth = new URL(start.headers.get('location')!);
    const state = auth.searchParams.get('state')!;
    const cookie = start.headers.getSetCookie()[0]!.split(';')[0]!;
    const result = await app(
      new Request(
        `${consumer.origin}/api/auth/callback?state=${state}&code=${codeFor(auth, email, failure)}`,
        { headers: { Cookie: cookie } },
      ),
    );
    const session = result.headers
      .getSetCookie()
      .find((v) => v.startsWith(cookieName(consumer, 'session') + '='));
    return { status: result.status, session: session?.split(';')[0], auth };
  }

  test('bootstrap requires OIDC, provisions once with audit, then refuses', async () => {
    const missing = await bootstrap({}, 'Dona.Piloto@gmail.test');
    expect(missing.code).not.toBe(0);
    expect(missing.out).toContain('Configure OIDC before provisioning');
    const first = await bootstrap(oidcEnv, 'Dona.Piloto@gmail.test');
    expect(first.out).toContain('First administrator provisioned');
    expect(first.code).toBe(0);
    expect(first.out).not.toContain(oidcEnv.OIDC_CLIENT_SECRET);
    const row = (
      await pool.query(
        'SELECT u.email,u.subject,m.role,m.active FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.organization_id=$1',
        [org],
      )
    ).rows;
    expect(row).toEqual([
      {
        email: 'dona.piloto@gmail.test',
        subject: null,
        role: 'administrator',
        active: true,
      },
    ]);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM audit_events WHERE organization_id=$1 AND actor='offline-bootstrap' AND action='first-administrator-provisioned'",
          [org],
        )
      ).rows[0].n,
    ).toBe(1);
    const second = await bootstrap(oidcEnv, 'outra@gmail.test');
    expect(second.code).not.toBe(0);
    expect(second.out).toContain('Administrator already exists');
    expect(
      (await pool.query("SELECT 1 FROM users WHERE email='outra@gmail.test'"))
        .rowCount,
    ).toBe(0);
  });

  test('without Workspace domain: only provisioned verified accounts get a session', async () => {
    const app = createApp(consumer, oidcProvider(consumer, fetcher), {
      pool,
      loginRate: { limit: 1000, windowSeconds: 60 },
    });
    const stranger = await login(app, 'estranho@gmail.test', 'consumer');
    expect(stranger.auth.searchParams.has('hd')).toBe(false);
    expect([stranger.status, stranger.session]).toEqual([403, undefined]);
    const admin = await login(app, 'dona.piloto@gmail.test', 'consumer');
    expect(admin.status).toBe(303);
    expect(admin.session).toBeDefined();
    const view = await app(
      new Request(`${consumer.origin}/api/session`, {
        headers: { Cookie: admin.session! },
      }),
    );
    expect(view.status).toBe(200);
    const body = (await view.json()) as {
      user: { email: string };
      role?: string;
    };
    expect(JSON.stringify(body)).toContain('administrator');
    const mission = await app(
      new Request(`${consumer.origin}/api/mission-control`, {
        headers: { Cookie: admin.session! },
      }),
    );
    expect(mission.status).toBe(200);
    // First login binds the Google subject: another account reusing the email is refused.
    expect(
      (
        await pool.query(
          "SELECT subject FROM users WHERE email='dona.piloto@gmail.test'",
        )
      ).rows[0].subject,
    ).toBe('sub:dona.piloto@gmail.test');
  });

  test('with a Workspace domain configured, consumer accounts are refused', async () => {
    const app = createApp(workspace, oidcProvider(workspace, fetcher), {
      pool,
      loginRate: { limit: 1000, windowSeconds: 60 },
    });
    const r = await login(app, 'dona.piloto@gmail.test', 'consumer');
    expect(r.auth.searchParams.get('hd')).toBe('catus.test');
    expect([r.status, r.session]).toEqual([401, undefined]);
  });
});
