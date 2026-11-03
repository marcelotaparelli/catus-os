import { describe, expect, test } from 'bun:test';
import {
  hoursText,
  moneyText,
  parseHours,
  parseMoney,
  parsePercent,
  percentText,
} from '../src/shared/units';

const value = (p: { ok: boolean; value?: unknown }) =>
  p.ok ? p.value : undefined;

describe('money typed on screen', () => {
  test.each([
    ['1234', '123400'],
    ['1234,5', '123450'],
    ['1234,56', '123456'],
    ['1.234,56', '123456'],
    ['1.234.567,89', '123456789'],
    ['0', '0'],
    ['0,01', '1'],
    // Beyond Number precision: stays exact.
    ['90.071.992.547.409,93', '9007199254740993'],
  ])('%s is %s minor units', (raw, minor) => {
    expect(value(parseMoney(raw, 'BRL'))).toBe(minor);
  });
  test.each(['12.50', '1,234', '1.23', '1,2,3', '-5', 'R$ 10', '1e3', '12.5'])(
    '%s is refused instead of guessed',
    (raw) => {
      const p = parseMoney(raw, 'BRL');
      expect(p.ok).toBe(false);
      if (!p.ok) expect(p.empty).toBe(false);
    },
  );
  test('blank is absent, never zero', () => {
    expect(parseMoney('  ', 'BRL')).toMatchObject({ ok: false, empty: true });
  });
  test('currencies without cents', () => {
    expect(value(parseMoney('1.500', 'JPY'))).toBe('1500');
    expect(parseMoney('15,50', 'JPY').ok).toBe(false);
    expect(moneyText('1500', 'JPY')).toBe('1.500');
  });
  test.each(['0', '5', '100', '123456', '100000000', '9007199254740993'])(
    '%s minor units survives the round trip',
    (minor) => {
      expect(value(parseMoney(moneyText(minor, 'BRL'), 'BRL'))).toBe(minor);
    },
  );
  test('absent stays blank', () => {
    expect(moneyText(null, 'BRL')).toBe('');
    expect(moneyText('', 'BRL')).toBe('');
  });
});

describe('percent typed on screen', () => {
  test.each([
    ['8', 800],
    ['8,5', 850],
    ['8,25', 825],
    ['0', 0],
    ['100', 10000],
    ['2 %', 200],
  ])('%s is %i bps', (raw, bps) => {
    expect(value(parsePercent(raw))).toBe(bps);
  });
  test.each(['100,01', '101', '8.5', '8,255', 'x'])('%s is refused', (raw) => {
    expect(parsePercent(raw).ok).toBe(false);
  });
  test.each([0, 1, 10, 200, 825, 850, 10000])(
    '%i bps survives the round trip',
    (bps) => {
      expect(value(parsePercent(percentText(bps)))).toBe(bps);
    },
  );
  test('absent stays blank', () => {
    expect(percentText(undefined)).toBe('');
    expect(parsePercent('')).toMatchObject({ ok: false, empty: true });
  });
});

describe('hours typed on screen', () => {
  test.each([
    ['2', 120],
    ['1,5', 90],
    ['1,25', 75],
    ['1:30', 90],
    ['1h30', 90],
    ['1h', 60],
    ['1 h', 60],
    ['90min', 90],
    ['0', 0],
  ])('%s is %i minutes', (raw, minutes) => {
    expect(value(parseHours(raw))).toBe(minutes);
  });
  // 0,33 h is 19,8 minutes: the API stores whole minutes, so it is refused, not rounded.
  test.each(['0,33', '1h75', '1:60', '1.5', 'abc'])('%s is refused', (raw) => {
    expect(parseHours(raw).ok).toBe(false);
  });
  test.each([0, 1, 59, 60, 75, 480, 1440])(
    '%i minutes survives the round trip',
    (minutes) => {
      expect(value(parseHours(hoursText(minutes)))).toBe(minutes);
    },
  );
  test('absent stays blank', () => {
    expect(hoursText(null)).toBe('');
    expect(parseHours('')).toMatchObject({ ok: false, empty: true });
  });
});
