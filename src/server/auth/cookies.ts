import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '../config';
export const randomToken = () => randomBytes(32).toString('base64url');
export const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
export function same(a: string, b: string) {
  return timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
}
export function cookieName(config: AppConfig, kind: 'session' | 'oidc') {
  return `${config.secureCookies ? '__Host-' : ''}catus_${kind}`;
}
export function readCookie(request: Request, name: string) {
  const values = (request.headers.get('cookie') ?? '')
    .split(';')
    .map((v) => v.trim())
    .filter((v) => v.startsWith(name + '='));
  return values.length === 1 ? values[0]!.slice(name.length + 1) : '';
}
export function cookie(
  config: AppConfig,
  kind: 'session' | 'oidc',
  value: string,
  maxAge: number,
) {
  return `${cookieName(config, kind)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.secureCookies ? '; Secure' : ''}`;
}
