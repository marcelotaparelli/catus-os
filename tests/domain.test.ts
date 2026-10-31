import { describe, expect, test } from 'bun:test';
import {
  text,
  uuid,
  status,
  transition,
  statuses,
  transitions,
} from '../src/shared/domain';
describe('domain validation', () => {
  test('trims text and rejects empty, non-string and overlong values', () => {
    expect(text('  Cliente  ', 'Nome')).toBe('Cliente');
    for (const v of ['', '  ', null, 42, 'a'.repeat(201)])
      expect(() => text(v, 'Nome')).toThrow();
  });
  test('rejects invalid identifiers and states', () => {
    expect(uuid(crypto.randomUUID())).toBeString();
    expect(() => uuid("' OR true--")).toThrow();
    expect(() => status('approved')).toThrow();
  });
  test('enforces every transition pair', () => {
    for (const from of statuses)
      for (const to of statuses) {
        if (from === to || transitions[from].includes(to))
          expect(() => transition(from, to)).not.toThrow();
        else expect(() => transition(from, to)).toThrow();
      }
  });
});
