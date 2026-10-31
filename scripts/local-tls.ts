import { mkdirSync, existsSync, writeFileSync, chmodSync } from 'node:fs';
const dir = '.local/tls';
mkdirSync(dir, { recursive: true, mode: 0o700 });
if (
  ['ca.key', 'ca.crt', 'server.key', 'server.crt'].some((n) =>
    existsSync(`${dir}/${n}`),
  )
)
  throw new Error(
    'TLS files already exist; preserve them and rotate explicitly',
  );
async function run(args: string[]) {
  const p = Bun.spawn(['openssl', ...args], {
    stdout: 'ignore',
    stderr: 'pipe',
  });
  if ((await p.exited) !== 0) throw new Error('OpenSSL generation failed');
}
await run([
  'req',
  '-x509',
  '-newkey',
  'rsa:2048',
  '-nodes',
  '-keyout',
  `${dir}/ca.key`,
  '-out',
  `${dir}/ca.crt`,
  '-days',
  '7',
  '-subj',
  '/CN=Catus Local Homologation CA',
  '-addext',
  'basicConstraints=critical,CA:TRUE',
  '-addext',
  'keyUsage=critical,keyCertSign,cRLSign',
]);
await run([
  'req',
  '-newkey',
  'rsa:2048',
  '-nodes',
  '-keyout',
  `${dir}/server.key`,
  '-out',
  `${dir}/server.csr`,
  '-subj',
  '/CN=localhost',
]);
writeFileSync(
  `${dir}/server.ext`,
  'subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n',
  { mode: 0o600 },
);
await run([
  'x509',
  '-req',
  '-in',
  `${dir}/server.csr`,
  '-CA',
  `${dir}/ca.crt`,
  '-CAkey',
  `${dir}/ca.key`,
  '-CAcreateserial',
  '-out',
  `${dir}/server.crt`,
  '-days',
  '7',
  '-extfile',
  `${dir}/server.ext`,
]);
for (const n of ['ca.key', 'server.key']) chmodSync(`${dir}/${n}`, 0o600);
console.log(
  'Local CA and localhost certificate created (7 days); trust ca.crt explicitly, never ignore TLS errors',
);
