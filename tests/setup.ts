const target =
  process.env.TEST_DATABASE_URL ??
  'postgres://catus:catus_local_only@127.0.0.1:5432/catus_test';
const url = new URL(target);
if (
  !['localhost', '127.0.0.1'].includes(url.hostname) ||
  !/^\/[a-z][a-z0-9_]*_test$/.test(url.pathname) ||
  (process.env.DATABASE_URL &&
    new URL(process.env.DATABASE_URL).pathname === url.pathname)
)
  throw new Error('Refusing unsafe test database');
process.env.DATABASE_URL = target;
process.env.RUNTIME_DATABASE_URL = target;

export {};
