import { describe, it, expect, vi, beforeEach } from 'vitest';

// This service has never had a direct test — its cap logic has only ever run
// under `vi.mock` from the route tests, which is precisely why #2775 shipped.
//
// Mocked the same way apps/api/src/routes/enrollmentKeys_installer.test.ts
// does: the service calls `db.select().from(enrollmentKeys).where(...).limit(1)`
// for the parent lookup (not `db.query.enrollmentKeys.findFirst`), so the
// mock shape has to match that chain.
vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
  },
}));

// Partner-cap defensive bound (fix round 3, #2776). Mocked at the wiring
// level — see enrollmentKeys.test.ts's identically-named-pattern helper for
// rationale. Permissive default (returns ttlMinutes unchanged) models "no
// partner cap configured", so every pre-existing test in this file (which
// predates the cap bound) keeps passing.
const clampTtlToCapMock = vi.fn(
  async (_orgId: string, ttlMinutes: number) => ttlMinutes,
);
vi.mock('../services/enrollmentDefaults', () => ({
  clampTtlToCap: (...args: [string, number]) => clampTtlToCapMock(...args),
}));

import { db } from '../db';
import { issueBootstrapTokenForKey } from './installerBootstrapTokenIssuance';

function mockParent(overrides: Record<string, unknown> = {}) {
  const parent = {
    id: 'parent-1',
    name: 'Add device installer',
    orgId: 'org-1',
    siteId: 'site-1',
    maxUsage: null,
    usageCount: 0,
    // deliberately near-dead: the transient 60-min parent, 59 min in
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([parent]),
      }),
    }),
  } as any);
  return parent;
}

function mockInsert() {
  vi.mocked(db.insert).mockReturnValueOnce({
    values: (v: Record<string, unknown>) => ({
      returning: async () => [{ id: 'tok-1', ...v }],
    }),
  } as any);
}

describe('issueBootstrapTokenForKey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // vi.clearAllMocks clears call history but NOT implementations — restore
    // the permissive default every test.
    clampTtlToCapMock.mockReset();
    clampTtlToCapMock.mockImplementation(async (_orgId: string, ttlMinutes: number) => ttlMinutes);
  });

  it('honours ttlMinutes even when the parent expires sooner (#2775)', async () => {
    mockParent();
    mockInsert();

    const result = await issueBootstrapTokenForKey({
      parentEnrollmentKeyId: 'parent-1',
      createdByUserId: 'user-1',
      maxUsage: 5,
      ttlMinutes: 10080, // 7 days
    });

    const ttlMs = result.expiresAt.getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(10080 * 60 * 1000 - 60_000);
  });

  it('falls back to the 24h base TTL when ttlMinutes is omitted', async () => {
    mockParent();
    mockInsert();

    const result = await issueBootstrapTokenForKey({
      parentEnrollmentKeyId: 'parent-1',
      createdByUserId: 'user-1',
    });

    const ttlMs = result.expiresAt.getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(23 * 60 * 60 * 1000);
  });

  // Fix round 4 (#2776). The round-3 code computed minutes from rawExpiresAt
  // and then ALWAYS rebuilt the Date from them, reading the clock a third
  // time — so an unclamped expiry came back a few milliseconds LATER than the
  // one the request implied. (The round-3 comment blamed `Math.ceil` producing
  // 1441 minutes; arithmetically impossible — the quotient is
  // `requested - elapsed/60000`, always <= requested.) The contract now is an
  // IDENTITY one: when the cap does not bind, the returned expiry must be the
  // exact same instant `rawExpiresAt` named, not merely "about right".
  //
  // Date.now is stubbed to advance a few ms per call so the three reads inside
  // the function are distinguishable — that is what makes this discriminating
  // rather than the previous tolerance-window assertion, which passed against
  // the pre-fix code too.
  it('returns the raw expiry byte-identically when the cap does not bind (#2776 round 4)', async () => {
    mockParent();
    mockInsert();

    const t0 = Date.now();
    let nowCalls = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => t0 + nowCalls++ * 7);

    try {
      const result = await issueBootstrapTokenForKey({
        parentEnrollmentKeyId: 'parent-1',
        createdByUserId: 'user-1',
        ttlMinutes: 1440,
      });

      // rawExpiresAt is built on the FIRST Date.now() read, i.e. exactly t0.
      const rawExpiresAt = new Date(t0 + 1440 * 60 * 1000);
      expect(result.expiresAt.getTime()).toBe(rawExpiresAt.getTime());
    } finally {
      nowSpy.mockRestore();
    }
  });

  // The floor + verbatim-passthrough pair has one documented boundary: a cap
  // exactly one minute below the request is NON-binding, so the token is
  // issued at the full requested lifetime — up to 60s over the cap. Pinned so
  // nobody "fixes" the drift-free passthrough without noticing they changed
  // this, and so the comment in the service can't rot away from the code.
  it('a cap one minute below the request is non-binding (documented <60s overshoot)', async () => {
    mockParent();
    mockInsert();
    clampTtlToCapMock.mockImplementation(async (_orgId: string, ttlMinutes: number) =>
      Math.min(ttlMinutes, 1439),
    );

    const t0 = Date.now();
    let nowCalls = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => t0 + nowCalls++ * 7);

    try {
      const result = await issueBootstrapTokenForKey({
        parentEnrollmentKeyId: 'parent-1',
        createdByUserId: 'user-1',
        ttlMinutes: 1440,
      });

      // floor(1440 - 7ms) === 1439 === the cap, so the clamp is a no-op and
      // the full 1440-minute expiry survives.
      expect(clampTtlToCapMock).toHaveBeenCalledWith('org-1', 1439);
      expect(result.expiresAt.getTime()).toBe(t0 + 1440 * 60 * 1000);
      // The overshoot is bounded by one minute — never more.
      expect(result.expiresAt.getTime() - (t0 + 1439 * 60 * 1000)).toBeLessThanOrEqual(60_000);
    } finally {
      nowSpy.mockRestore();
    }
  });

  // Fix round 3 (#2776): a defensive CLAMP (never a rejection) so the
  // partner cap can't be bypassed by a caller that forgets to check it —
  // in particular serveInstaller's unauthenticated public-download path,
  // which passes no ttlMinutes at all and had no cap consult anywhere in
  // its call chain before this fix.
  it('clamps the 24h base TTL down when the partner cap is below it', async () => {
    mockParent();
    mockInsert();
    clampTtlToCapMock.mockImplementation(async (_orgId: string, ttlMinutes: number) =>
      Math.min(ttlMinutes, 60), // partner cap: 60 minutes
    );

    const result = await issueBootstrapTokenForKey({
      parentEnrollmentKeyId: 'parent-1',
      createdByUserId: 'user-1',
    });

    const ttlMs = result.expiresAt.getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(59 * 60 * 1000 - 5_000);
    expect(ttlMs).toBeLessThanOrEqual(60 * 60 * 1000);
    expect(clampTtlToCapMock).toHaveBeenCalledWith('org-1', expect.any(Number));
  });

  it('clamps an explicit ttlMinutes down when it exceeds the partner cap', async () => {
    mockParent();
    mockInsert();
    clampTtlToCapMock.mockImplementation(async (_orgId: string, ttlMinutes: number) =>
      Math.min(ttlMinutes, 1440), // partner cap: 24h
    );

    const result = await issueBootstrapTokenForKey({
      parentEnrollmentKeyId: 'parent-1',
      createdByUserId: 'user-1',
      ttlMinutes: 43200, // 30 days requested
    });

    const ttlMs = result.expiresAt.getTime() - Date.now();
    // Clamped to the 1440-minute (24h) cap, NOT the requested 30 days.
    expect(ttlMs).toBeLessThanOrEqual(1440 * 60 * 1000 + 5_000);
    expect(ttlMs).toBeGreaterThan(1439 * 60 * 1000);
  });

  it('does not change the TTL when the partner cap is above it (no-op clamp)', async () => {
    mockParent();
    mockInsert();
    clampTtlToCapMock.mockImplementation(async (_orgId: string, ttlMinutes: number) =>
      Math.min(ttlMinutes, 525_600), // generous partner cap
    );

    const result = await issueBootstrapTokenForKey({
      parentEnrollmentKeyId: 'parent-1',
      createdByUserId: 'user-1',
      ttlMinutes: 10080, // 7 days
    });

    const ttlMs = result.expiresAt.getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(10080 * 60 * 1000 - 60_000);
  });
});
