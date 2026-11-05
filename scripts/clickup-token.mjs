// `bun run clickup:token`: the owner types the ClickUp token on the authorized machine. It is
// read without echo from an interactive terminal only (never a pipe, an argument or the shell
// history), validated, and written atomically to a 0600 file outside the repository. Nothing
// is printed back. The worker launcher reads that file as data (scripts/lib/secret-file.mjs).
import {
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  CLICKUP_TOKEN,
  checkSecretFile,
  defaultTokenFile,
} from './lib/secret-file.mjs';

const fail = (message) => {
  console.error(message);
  process.exit(1);
};
const at = process.argv.indexOf('--file');
const file = resolve(
  at > 0 ? (process.argv[at + 1] ?? '') : defaultTokenFile(),
);
const replace = process.argv.includes('--replace');
const repo = relative(process.cwd(), file);
if (!repo.startsWith('..') && !isAbsolute(repo))
  fail('Recusado: o arquivo do token precisa ficar fora do repositório.');
if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function')
  fail(
    'Recusado: digite o token num terminal interativo. Pipe, argumento ou arquivo não são aceitos.',
  );
let exists = false;
try {
  lstatSync(file);
  exists = true;
} catch {}
if (exists && !replace)
  fail(`Já existe um token em ${file}. Use --replace para substituí-lo.`);
const dir = dirname(file);
mkdirSync(dir, { recursive: true, mode: 0o700 });
const d = lstatSync(dir);
if (d.uid !== process.getuid() || d.mode & 0o022)
  fail(
    `Recusado: ${dir} precisa ser do usuário atual e não gravável por outros.`,
  );

const token = await new Promise((done) => {
  let value = '';
  process.stdout.write('Token do ClickUp (não aparece na tela): ');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  const stop = (result) => {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdin.removeAllListeners('data');
    process.stdout.write('\n');
    done(result);
  };
  process.stdin.on('data', (chunk) => {
    for (const ch of chunk) {
      if (ch === '\u0003') return stop(null); // Ctrl+C
      if (ch === '\r' || ch === '\n') return stop(value);
      if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
      else value += ch;
    }
  });
});
if (token === null) fail('Cancelado; nada foi gravado.');
if (!CLICKUP_TOKEN.test(token.trim()))
  fail('Formato inesperado; nada foi gravado. O valor digitado não é exibido.');
const temporary = `${file}.tmp-${process.pid}`;
try {
  writeFileSync(temporary, token.trim() + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(temporary, file);
  checkSecretFile(file, { repository: process.cwd() });
} catch (e) {
  rmSync(temporary, { force: true });
  fail(e.message ?? 'Falha ao gravar; nada foi gravado.');
}
console.log(
  `Token gravado em ${file} (0600). O conteúdo não foi exibido nem registrado.`,
);
