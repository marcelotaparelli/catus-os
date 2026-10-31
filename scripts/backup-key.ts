import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const file = process.env.BACKUP_KEY_FILE ?? '.local/backup.key';
mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
writeFileSync(file, randomBytes(32), { mode: 0o600, flag: 'wx' });
console.log(
  'Backup key created privately; keep a separate secure copy, never commit or print it',
);
