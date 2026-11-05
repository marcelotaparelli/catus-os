export const CLICKUP_TOKEN: RegExp;
export class SecretFileError extends Error {
  rule: string;
}
interface Options {
  repository?: string;
  pattern?: RegExp;
  uid?: number;
}
export function checkSecretFile(path: string, options?: Options): string;
export function readSecretFile(path: string, options?: Options): string;
export function defaultTokenFile(home?: string): string;
