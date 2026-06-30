import { describe, it, expect } from 'vitest';
import {
  severityRankToLabel,
  resolveFindingLinkOut,
  buildIncidentFeedQueries,
} from './incidents.helpers';
import type { AuthContext } from '../middleware/auth';

// Minimal org-scoped auth for the DB-less build guard. buildIncidentFeedQueries
// only reads auth.scope / auth.orgId via resolveOrgFilter, so the rest is unused.
const orgAuth = {
  scope: 'organization',
  orgId: '22222222-2222-4222-8222-222222222222',
} as unknown as AuthContext;

describe('severityRankToLabel', () => {
  it('maps rank 1..4 to p1..p4 and clamps unknown to p3', () => {
    expect(severityRankToLabel(1)).toBe('p1');
    expect(severityRankToLabel(2)).toBe('p2');
    expect(severityRankToLabel(3)).toBe('p3');
    expect(severityRankToLabel(4)).toBe('p4');
    expect(severityRankToLabel(99)).toBe('p3');
  });
});

describe('resolveFindingLinkOut', () => {
  it('returns the stored portal url when present', () => {
    expect(resolveFindingLinkOut('huntress', { portalUrl: 'https://huntress.io/x' })).toBe('https://huntress.io/x');
  });
  it('returns null when no url is derivable', () => {
    expect(resolveFindingLinkOut('s1', null)).toBeNull();
  });
});

// DB-less build guard. This is the exact failure mode that made GET
// /incidents/feed non-functional: without `.as('<key>')` aliases on the union
// legs, drizzle throws synchronously at query-BUILD time ("you tried to
// reference 'kind' field from a subquery ... but it doesn't have an alias");
// and the old `.orderBy(sql`detected_at desc`)` referenced an unquoted
// identifier that Postgres folds to lowercase ("column 'detected_at' does not
// exist"). `.toSQL()` builds the statement synchronously without a DB
// connection, so this runs in the normal unit suite.
describe('buildIncidentFeedQueries (DB-less build guard)', () => {
  const params = { limit: 50, offset: 0 } as const;

  it('builds the union feed query without throwing', () => {
    expect(() => buildIncidentFeedQueries(orgAuth, params)).not.toThrow();
    const built = buildIncidentFeedQueries(orgAuth, params);
    expect(built).not.toBeNull();
  });

  it('aliases every union-leg field (regression: missing .as() throws at build time)', () => {
    const built = buildIncidentFeedQueries(orgAuth, params)!;
    const { sql } = built.rowsQuery.toSQL();
    for (const key of [
      'kind',
      'source',
      'sourceId',
      'title',
      'rank',
      'edrStatus',
      'status',
      'deviceId',
      'detectedAt',
      'trackedIncidentId',
      'details',
    ]) {
      expect(sql).toContain(`as "${key}"`);
    }
  });

  it('orders by the quoted aliased columns, not unquoted detected_at', () => {
    const built = buildIncidentFeedQueries(orgAuth, params)!;
    const { sql } = built.rowsQuery.toSQL();
    expect(sql).toContain('order by');
    expect(sql).toContain('"rank"');
    expect(sql).toContain('"detectedAt"');
    // The pre-fix bug: an unquoted detected_at identifier in the ORDER BY.
    expect(sql).not.toMatch(/order by[^()]*\bdetected_at\b/);
  });

  it('returns null when kind/source filters exclude every leg', () => {
    // kind=tracked + source=huntress is contradictory → no legs.
    const built = buildIncidentFeedQueries(orgAuth, {
      ...params,
      kind: 'tracked',
      source: 'huntress',
    });
    expect(built).toBeNull();
  });
});
