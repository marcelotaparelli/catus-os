import { loadConfig } from '../src/server/config';
import { validateGoogleProfile } from '../src/server/google-profile';
import { pool } from '../src/server/db';
import { assertRuntimePrivileges } from './lib/privileges';
try {
  const profile = validateGoogleProfile(loadConfig());
  if (!process.env.TLS_CERT_FILE || !process.env.TLS_KEY_FILE)
    throw new Error('TLS_CERT_FILE and TLS_KEY_FILE required');
  if (
    !(await Bun.file(process.env.TLS_CERT_FILE).exists()) ||
    !(await Bun.file(process.env.TLS_KEY_FILE).exists())
  )
    throw new Error('Configured TLS files unavailable');
  await assertRuntimePrivileges(pool);
  console.log('Offline configuration checks passed:', profile);
  console.log(
    'Owner must still validate CA trust, Google consent/redirect and real accounts; no Google login was attempted',
  );
} catch (e) {
  console.error(
    e instanceof Error ? e.message : 'Homologation configuration incomplete',
  );
  process.exitCode = 2;
} finally {
  await pool.end();
}
