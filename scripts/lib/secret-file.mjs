// Reads a credential from a file without executing it (never `source`), and only when the
// file and its directory can be written by nobody but the current user. Errors name the
// rule that failed, never the content.
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

export const CLICKUP_TOKEN = /^[A-Za-z0-9_-]{8,200}$/;

export class SecretFileError extends Error {
  constructor(rule) {
    super(`Arquivo de credencial recusado: ${rule}`);
    this.name = 'SecretFileError';
    this.rule = rule;
  }
}
const inside = (dir, path) => {
  const r = relative(dir, path);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};
/**
 * @param {string} path absolute path of the credential file
 * @param {{ repository?: string, pattern?: RegExp, uid?: number }} options
 */
export function checkSecretFile(path, options = {}) {
  const uid = options.uid ?? process.getuid?.();
  if (typeof path !== 'string' || !isAbsolute(path))
    throw new SecretFileError('caminho absoluto obrigatório');
  let file;
  try {
    file = lstatSync(path);
  } catch {
    throw new SecretFileError('arquivo inexistente');
  }
  if (file.isSymbolicLink()) throw new SecretFileError('link simbólico');
  if (!file.isFile()) throw new SecretFileError('não é um arquivo comum');
  if (uid !== undefined && file.uid !== uid)
    throw new SecretFileError('dono diferente do usuário atual');
  if (file.mode & 0o077)
    throw new SecretFileError('permissões abertas; use chmod 600');
  if (file.size > 1024) throw new SecretFileError('arquivo grande demais');
  const dir = lstatSync(dirname(path));
  if (uid !== undefined && dir.uid !== uid)
    throw new SecretFileError('diretório de outro usuário');
  if (dir.mode & 0o022)
    throw new SecretFileError('diretório gravável por outros');
  const real = realpathSync(path);
  if (options.repository && inside(realpathSync(options.repository), real))
    throw new SecretFileError('dentro do repositório');
  return real;
}
/** The single line of the file, validated against `pattern`. */
export function readSecretFile(path, options = {}) {
  checkSecretFile(path, options);
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  const pattern = options.pattern ?? CLICKUP_TOKEN;
  if (lines.length !== 1 || !pattern.test(lines[0]))
    throw new SecretFileError('conteúdo fora do formato esperado');
  return lines[0];
}
export const defaultTokenFile = (home = process.env.HOME ?? '') =>
  resolve(home, '.config/catus-homolog/clickup-token');
