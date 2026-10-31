import { writeFileSync, existsSync } from 'node:fs';
if (existsSync('.env')) {
  console.log('.env exists; preserved without changes');
} else {
  writeFileSync(
    '.env',
    `DATABASE_URL=postgres://catus:catus_local_only@127.0.0.1:5432/catus\nAPP_ORIGIN=http://127.0.0.1:5173\nTEST_DATABASE_URL=postgres://catus:catus_local_only@127.0.0.1:5432/catus_test\nPORT=3000\n`,
    { mode: 0o600, flag: 'wx' },
  );
  console.log(
    'Created .env without OIDC credentials; login remains disabled; never commit it',
  );
}
