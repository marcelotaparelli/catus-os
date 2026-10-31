import { writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
if (existsSync('.env')) {
  console.log('.env exists; preserved without changes');
} else {
  writeFileSync(
    '.env',
    `DATABASE_URL=postgres://catus:catus_local_only@127.0.0.1:5432/catus\nDEV_TOKEN=${randomBytes(32).toString('hex')}\nPORT=3000\n`,
    { mode: 0o600, flag: 'wx' },
  );
  console.log('Created .env with a random local token; never commit it');
}
