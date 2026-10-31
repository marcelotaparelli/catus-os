import { provisionRoles } from './lib/provision-roles';
if (!process.env.DATABASE_URL)
  throw new Error('Administrative DATABASE_URL required');
await provisionRoles(process.env.DATABASE_URL, '.local/database.env');
console.log(
  'Database roles prepared; credentials stored in ignored .local/database.env (0600), never printed',
);
