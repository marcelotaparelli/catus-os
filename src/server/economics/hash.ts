import { createHash } from 'node:crypto';
function canonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object')
    return (
      '{' +
      Object.entries(v)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, val]) => JSON.stringify(k) + ':' + canonical(val))
        .join(',') +
      '}'
    );
  return JSON.stringify(v);
}
export function inputHash(value: unknown) {
  return createHash('sha256')
    .update(canonical(JSON.parse(JSON.stringify(value))))
    .digest('hex');
}
