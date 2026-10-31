import { backup, restore } from './lib/backup';
const mode = process.argv[2],
  file = process.argv[3];
if (!file) throw new Error('Usage: backup.ts backup|restore <archive>');
const key = process.env.BACKUP_KEY_FILE ?? '.local/backup.key';
if (mode === 'backup') {
  if (!process.env.MIGRATION_DATABASE_URL)
    throw new Error('MIGRATION_DATABASE_URL required');
  console.log(
    'Encrypted backup completed:',
    await backup(process.env.MIGRATION_DATABASE_URL, file, key),
  );
} else if (mode === 'restore') {
  if (
    !process.env.RESTORE_DATABASE_URL ||
    !process.env.RESTORE_RUNTIME_ROLE ||
    !process.env.RESTORE_MAINTENANCE_ROLE
  )
    throw new Error('Disposable restore URL and roles required');
  console.log(
    await restore(
      process.env.RESTORE_DATABASE_URL,
      file,
      key,
      process.env.RESTORE_RUNTIME_ROLE,
      process.env.RESTORE_MAINTENANCE_ROLE,
    ),
  );
} else throw new Error('Unknown backup mode');
