import type { Pool } from 'pg';
import { ident } from '../../scripts/lib/privileges';
/** pg.Pool.end may resolve before PostgreSQL observes every socket close. Never FORCE live clients. */
export async function dropDisposableDatabase(control: Pool, name: string) {
  if (!/^[a-z][a-z0-9_]*_test$/.test(name))
    throw new Error('Unsafe disposable database name');
  for (let attempt = 0; attempt < 200; attempt++) {
    const count = Number(
      (
        await control.query(
          'SELECT count(*) FROM pg_stat_activity WHERE datname=$1',
          [name],
        )
      ).rows[0].count,
    );
    if (count === 0) {
      await control.query(`DROP DATABASE IF EXISTS ${ident(name)}`);
      return;
    }
    await Bun.sleep(20);
  }
  throw new Error(
    'Disposable database connections did not drain; refused force-drop',
  );
}
