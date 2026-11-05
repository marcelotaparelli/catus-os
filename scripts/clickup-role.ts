// Run once, by the operator, only when the integration is being activated. Nothing else
// needs this account, so an installation that never activates ClickUp never gets it.
import { provisionClickupRole } from './lib/clickup-role';
if (!process.env.DATABASE_URL)
  throw new Error('Administrative DATABASE_URL required');
await provisionClickupRole(process.env.DATABASE_URL, '.local/database.env');
console.log(
  'ClickUp worker role ready; credential stored in ignored .local/database.env (0600), never printed',
);
