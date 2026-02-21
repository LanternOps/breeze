import { describe, expect, it } from 'vitest';

import { mergeSavedLogSearchFilters, sanitizeCorrelationPattern } from './logSearch';

describe('mergeSavedLogSearchFilters', () => {
  it('applies saved filters when request does not override fields', () => {
    const merged = mergeSavedLogSearchFilters(
      {
        query: 'saved',
        source: 'kernel',
        level: ['error'],
        limit: 250,
        sortBy: 'timestamp',
        sortOrder: 'desc',
      },
      {
        query: 'saved override',
      },
    );

    expect(merged).toEqual(expect.objectContaining({
      query: 'saved override',
      source: 'kernel',
      level: ['error'],
      limit: 250,
      sortBy: 'timestamp',
      sortOrder: 'desc',
    }));
  });

  it('supports backward-compatible saved search text field', () => {
    const merged = mergeSavedLogSearchFilters(
      {
        search: 'legacy field',
        source: 'agent',
      },
      {},
    );

    expect(merged.query).toBe('legacy field');
    expect(merged.source).toBe('agent');
  });
});

describe('sanitizeCorrelationPattern', () => {
  it('accepts simple text patterns', () => {
    expect(sanitizeCorrelationPattern(' connection reset ', false)).toBe('connection reset');
  });

  it('rejects overly long regex patterns', () => {
    expect(() => sanitizeCorrelationPattern('a'.repeat(301), true)).toThrow(/too long/i);
  });

  it('rejects regex lookarounds', () => {
    expect(() => sanitizeCorrelationPattern('(?=panic).*', true)).toThrow(/lookaround/i);
  });

  it('rejects regex backreferences', () => {
    expect(() => sanitizeCorrelationPattern('(foo)\\1', true)).toThrow(/backreference/i);
  });
});
