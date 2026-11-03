/**
 * What people type on screen ⇄ what the API stores. Display concern only: the payload the
 * server validates is unchanged (integer minor units, basis points, integer minutes).
 * A value that cannot be read exactly is refused, never rounded, and blank is never zero.
 */
export type Parsed<T> =
  | { ok: true; value: T }
  | { ok: false; empty: boolean; message: string };

const empty = { ok: false, empty: true, message: '' } as const;
const refuse = (message: string) =>
  ({ ok: false, empty: false, message }) as const;
const noCents = (currency: string) => ['JPY', 'CLP'].includes(currency);

/** Accepts 1234 · 1234,5 · 1234,56 · 1.234,56. A dot is only a thousands separator. */
export function parseMoney(raw: string, currency: string): Parsed<string> {
  const text = raw.trim();
  if (!text) return empty;
  if (
    /^\d+\.\d{1,2}$/.test(text) ||
    !/^(\d+|\d{1,3}(\.\d{3})+)(,\d{1,2})?$/.test(text)
  )
    return refuse('Use o formato 1.234,56 (vírgula antes dos centavos).');
  const [whole = '', cents = ''] = text.replaceAll('.', '').split(',');
  if (noCents(currency)) {
    if (cents) return refuse(`${currency} não tem centavos.`);
    return { ok: true, value: BigInt(whole).toString() };
  }
  return {
    ok: true,
    value: (BigInt(whole) * 100n + BigInt(cents.padEnd(2, '0'))).toString(),
  };
}

export function moneyText(
  minor: string | null | undefined,
  currency: string,
): string {
  if (minor == null || minor === '') return '';
  const n = BigInt(minor);
  const group = (v: bigint) => v.toString().replace(/\B(?=(\d{3})+$)/g, '.');
  if (noCents(currency)) return group(n);
  return `${group(n / 100n)},${(n % 100n).toString().padStart(2, '0')}`;
}

/** Percentage with up to two decimals, as integer basis points: 8,5 → 850. */
export function parsePercent(raw: string): Parsed<number> {
  const text = raw.trim().replace(/\s*%$/, '');
  if (!text) return empty;
  if (!/^\d{1,3}(,\d{1,2})?$/.test(text))
    return refuse('Use um percentual como 8 ou 8,5.');
  const [whole = '0', part = ''] = text.split(',');
  const bps = Number(whole) * 100 + Number(part.padEnd(2, '0'));
  return bps > 10000
    ? refuse('O percentual não pode passar de 100%.')
    : { ok: true, value: bps };
}

export function percentText(bps: number | null | undefined): string {
  if (bps == null) return '';
  const part = bps % 100;
  return part
    ? `${Math.floor(bps / 100)},${String(part).padStart(2, '0').replace(/0$/, '')}`
    : String(bps / 100);
}

/** Duration as integer minutes: 2 · 1,5 · 1:30 · 1h30 · 1h · 90min. */
export function parseHours(raw: string): Parsed<number> {
  const text = raw.trim().toLowerCase();
  if (!text) return empty;
  const hint = 'Use 2, 1,5, 1:30, 1h30 ou 90min.';
  let m;
  if ((m = /^(\d+)\s*min$/.exec(text)))
    return { ok: true, value: Number(m[1]) };
  if ((m = /^(\d+)\s*(?:h|:)\s*(\d{1,2})?$/.exec(text))) {
    const minutes = Number(m[2] ?? 0);
    if (minutes > 59) return refuse(hint);
    return { ok: true, value: Number(m[1]) * 60 + minutes };
  }
  if ((m = /^(\d+)(?:,(\d{1,2}))?$/.exec(text))) {
    const hundredths = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
    const minutes = (hundredths * 60) / 100;
    if (!Number.isInteger(minutes))
      return refuse(`Não dá minutos inteiros. ${hint}`);
    return { ok: true, value: minutes };
  }
  return refuse(hint);
}

export function hoursText(minutes: number | null | undefined): string {
  if (minutes == null) return '';
  const h = Math.floor(minutes / 60),
    m = minutes % 60;
  return m ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
}
