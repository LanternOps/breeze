import { describe, expect, it } from 'vitest';

import { normalizeCorrelationTimestamp } from './logSearch';

describe('normalizeCorrelationTimestamp', () => {
  it('normalizes raw PostgreSQL timestamp strings to Date values', () => {
    const timestamp = normalizeCorrelationTimestamp('2026-09-06T12:34:56.789Z', 'firstSeen');

    expect(timestamp).toBeInstanceOf(Date);
    expect(timestamp?.toISOString()).toBe('2026-09-06T12:34:56.789Z');
  });

  it('copies already-decoded Date values and preserves null aggregates', () => {
    const source = new Date('2026-09-06T12:34:56.789Z');
    const timestamp = normalizeCorrelationTimestamp(source, 'lastSeen');

    expect(timestamp).not.toBe(source);
    expect(timestamp?.getTime()).toBe(source.getTime());
    expect(normalizeCorrelationTimestamp(null, 'firstSeen')).toBeNull();
  });

  it.each([
    ['malformed text', 'not-a-timestamp'],
    ['non-date object', {}],
    ['numeric coercion', 0],
  ])('fails closed for %s', (_label, value) => {
    expect(() => normalizeCorrelationTimestamp(value, 'firstSeen'))
      .toThrow('Invalid correlation firstSeen timestamp');
  });
});
