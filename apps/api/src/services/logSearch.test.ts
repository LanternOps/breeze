import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import {
  buildLogSearchKeysetCondition,
  decodeSearchCursor,
  encodeSearchCursor,
  mergeSavedLogSearchFilters,
  resolveSingleOrgId,
  sanitizeCorrelationPattern,
} from './logSearch';

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

  it('rejects empty text pattern', () => {
    expect(() => sanitizeCorrelationPattern('   ', false)).toThrow(/empty/i);
  });

  it('rejects text pattern exceeding 1000 characters', () => {
    expect(() => sanitizeCorrelationPattern('a'.repeat(1001), false)).toThrow(/too long/i);
  });

  it('rejects regex with too many meta characters', () => {
    // 31 groups = 62 parens + 31 dots + 31 stars = 124 meta chars, well over the 60 limit
    const pattern = Array.from({ length: 31 }, () => '(.*)').join('');
    expect(() => sanitizeCorrelationPattern(pattern, true)).toThrow(/too complex/i);
  });

  it('rejects syntactically invalid regex', () => {
    expect(() => sanitizeCorrelationPattern('[unclosed', true)).toThrow(/invalid regex/i);
  });

  it('accepts valid regex pattern', () => {
    expect(sanitizeCorrelationPattern('error.*timeout', true)).toBe('error.*timeout');
  });

  it('rejects regex with too many alternations', () => {
    // 27 terms joined by 26 pipes, over the 25 alternation limit
    const pattern = Array.from({ length: 27 }, () => 'a').join('|');
    expect(() => sanitizeCorrelationPattern(pattern, true)).toThrow(/too complex/i);
  });
});

describe('search cursor round-trip (#3329)', () => {
  const CURSOR_ID = '56d661ad-4fa9-45d8-8dab-eba1fd8fb20c';

  it('decodes a cursor it issued back to the same timestamp and id', () => {
    const timestamp = new Date('2026-08-10T06:14:42.123Z');
    const decoded = decodeSearchCursor(encodeSearchCursor({ timestamp, id: CURSOR_ID }));

    expect(decoded.id).toBe(CURSOR_ID);
    // Millisecond fidelity matters: the keyset predicate uses `timestamp = cursor`
    // as the tiebreaker branch, so any drift there silently skips rows.
    expect(decoded.timestamp.toISOString()).toBe(timestamp.toISOString());
  });

  it('accepts a standard base64 cursor, not just base64url', () => {
    const timestamp = new Date('2026-08-10T06:14:42.000Z');
    const standardBase64 = Buffer.from(
      JSON.stringify({ timestamp: timestamp.toISOString(), id: CURSOR_ID }),
    ).toString('base64');

    expect(decodeSearchCursor(standardBase64).id).toBe(CURSOR_ID);
  });

  it('rejects a malformed cursor rather than paging from an arbitrary point', () => {
    expect(() => decodeSearchCursor('not-base64-json')).toThrow(/invalid cursor/i);
    expect(() => decodeSearchCursor(
      Buffer.from(JSON.stringify({ timestamp: 'nope', id: CURSOR_ID })).toString('base64url'),
    )).toThrow(/invalid cursor payload/i);
    expect(() => decodeSearchCursor(
      Buffer.from(JSON.stringify({ timestamp: new Date().toISOString(), id: 'not-a-uuid' })).toString('base64url'),
    )).toThrow(/invalid cursor payload/i);
  });
});

describe('buildLogSearchKeysetCondition (#3329)', () => {
  const dialect = new PgDialect();
  const cursor = {
    timestamp: new Date('2026-08-10T06:14:42.000Z'),
    id: '56d661ad-4fa9-45d8-8dab-eba1fd8fb20c',
  };

  /**
   * The bug this guards: the predicate used to be a hand-written `sql` template
   * that interpolated `cursor.timestamp` directly. A bare value in a `sql`
   * template is bound with the NOOP encoder, so the raw `Date` reached
   * postgres.js, whose Bind step threw ERR_INVALID_ARG_TYPE ("Received an
   * instance of Date"). Inside the request transaction that surfaced as an
   * HTTP 500 for the whole call, making `nextCursor` unusable.
   */
  it.each(['asc', 'desc'] as const)('binds no raw Date to the driver (sortOrder=%s)', (sortOrder) => {
    const { params } = dialect.sqlToQuery(buildLogSearchKeysetCondition(cursor, sortOrder));

    expect(params.length).toBeGreaterThan(0);
    for (const param of params) {
      expect(param).not.toBeInstanceOf(Date);
      expect(['string', 'number']).toContain(typeof param);
    }
    expect(params).toContain(cursor.id);
  });

  it('walks backwards for a descending sort and forwards for an ascending sort', () => {
    const desc = dialect.sqlToQuery(buildLogSearchKeysetCondition(cursor, 'desc')).sql;
    const asc = dialect.sqlToQuery(buildLogSearchKeysetCondition(cursor, 'asc')).sql;

    expect(desc).toContain('<');
    expect(desc).not.toContain('>');
    expect(asc).toContain('>');
    expect(asc).not.toContain('<');
    // Both directions need the id tiebreaker for rows sharing a timestamp,
    // otherwise a page boundary inside one millisecond loses or repeats rows.
    expect(desc).toContain('"device_event_logs"."id"');
    expect(asc).toContain('"device_event_logs"."id"');
  });
});

describe('resolveSingleOrgId', () => {
  it('returns null when requested orgId is not accessible', () => {
    const auth = {
      orgId: 'org-1',
      accessibleOrgIds: ['org-1'],
      canAccessOrg: (id: string) => id === 'org-1',
    } as any;
    expect(resolveSingleOrgId(auth, 'org-999')).toBeNull();
  });

  it('falls back to auth.orgId when no requestedOrgId is provided', () => {
    const auth = {
      orgId: 'org-1',
      accessibleOrgIds: ['org-1'],
      canAccessOrg: () => true,
    } as any;
    expect(resolveSingleOrgId(auth)).toBe('org-1');
  });

  it('returns single accessible orgId when auth.orgId is absent', () => {
    const auth = {
      orgId: null,
      accessibleOrgIds: ['only-org'],
      canAccessOrg: () => true,
    } as any;
    expect(resolveSingleOrgId(auth)).toBe('only-org');
  });

  it('returns null when multiple orgs are accessible and no orgId provided', () => {
    const auth = {
      orgId: null,
      accessibleOrgIds: ['org-a', 'org-b'],
      canAccessOrg: () => true,
    } as any;
    expect(resolveSingleOrgId(auth)).toBeNull();
  });
});
