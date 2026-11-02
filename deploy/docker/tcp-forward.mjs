// Minimal TCP forwarder. It copies bytes only: TLS stays end-to-end between the
// browser and the Catus server, and no header (Origin, Host, X-Forwarded-For) is
// read, added or changed, so origin/CSRF checks are unaffected.
//   FORWARD_LISTEN=<ip>:<port> FORWARD_TARGET=<host>:<port> node tcp-forward.mjs
// Usage: edge (container IP -> 127.0.0.1:3443 in the shared namespace) and
// admin tasks (127.0.0.1:5432 -> db:5432, because role/backup tooling only
// accepts loopback database URLs).
import net from 'node:net';
function endpoint(name) {
  const value = process.env[name] ?? '';
  const i = value.lastIndexOf(':');
  const host = value.slice(0, i),
    port = Number(value.slice(i + 1));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`${name} must be <host>:<port>`);
  return { host, port };
}
const listen = endpoint('FORWARD_LISTEN'),
  target = endpoint('FORWARD_TARGET');
if (['0.0.0.0', '::', ''].includes(listen.host))
  throw new Error('Refusing wildcard listen address');
const server = net.createServer({ pauseOnConnect: true }, (client) => {
  const upstream = net.connect(target.port, target.host);
  const close = () => {
    client.destroy();
    upstream.destroy();
  };
  for (const s of [client, upstream]) {
    s.setKeepAlive(true, 30_000);
    s.on('error', close);
    s.on('close', close);
  }
  upstream.once('connect', () => {
    client.pipe(upstream);
    upstream.pipe(client);
    client.resume();
  });
});
server.maxConnections = 512;
server.on('error', (e) => {
  console.error('forwarder error:', e.message);
  process.exit(1);
});
server.listen(listen.port, listen.host, () =>
  console.log(
    `forwarding ${listen.host}:${listen.port} -> ${target.host}:${target.port}`,
  ),
);
for (const s of ['SIGINT', 'SIGTERM'])
  process.on(s, () => server.close(() => process.exit(0)));
