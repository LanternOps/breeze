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
    expect(resolveFindingLinkOut({ portalUrl: 'https://huntress.io/x' })).toBe('https://huntress.io/x');
  });
  it('returns null when no url is derivable', () => {
    expect(resolveFindingLinkOut(null)).toBeNull();
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

  // FIX 1 (CRITICAL): site-level RBAC. A site-restricted caller's allowed device
  // ids must be pushed onto the huntress + s1 legs as the same null-device-OR-
  // in-list predicate the dedicated EDR routes use, so they cannot read EDR
  // findings for devices outside their sites via the feed.
  it('applies the site-allowlist predicate to the huntress and s1 legs when site-restricted', () => {
    const built = buildIncidentFeedQueries(orgAuth, {
      ...params,
      hasDevicesRead: true,
      allowedDeviceIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
    })!;
    const { sql } = built.rowsQuery.toSQL();
    // null-device carve-out + device-id IN (...) narrowing (mirrors EDR routes).
    expect(sql).toContain('"device_id" is null');
    expect(sql).toMatch(/"device_id" in \(/);
  });

  it('does not add a site predicate when the caller is not site-restricted', () => {
    const built = buildIncidentFeedQueries(orgAuth, {
      ...params,
      hasDevicesRead: true,
      allowedDeviceIds: null,
    })!;
    const { sql } = built.rowsQuery.toSQL();
    // The EDR legs still project device_id (select list), but no WHERE predicate
    // narrows on it — so the broad feed is not over-restricted.
    expect(sql).not.toContain('"device_id" is null');
    expect(sql).not.toMatch(/"device_id" in \(/);
  });

  // FIX 2: devices:read gate. A caller with alerts:read but not devices:read
  // sees only native tracked incidents — the raw EDR finding legs are omitted.
  it('omits the huntress and s1 legs entirely when the caller lacks devices:read', () => {
    const built = buildIncidentFeedQueries(orgAuth, {
      ...params,
      hasDevicesRead: false,
    })!;
    const { sql } = built.rowsQuery.toSQL();
    expect(sql).toContain('"incidents"');
    expect(sql).not.toContain('huntress_incidents');
    expect(sql).not.toContain('s1_threats');
  });

  it('yields an empty feed (null) when a no-devices-read caller filters to source=huntress', () => {
    const built = buildIncidentFeedQueries(orgAuth, {
      ...params,
      hasDevicesRead: false,
      source: 'huntress',
    });
    expect(built).toBeNull();
  });
});
