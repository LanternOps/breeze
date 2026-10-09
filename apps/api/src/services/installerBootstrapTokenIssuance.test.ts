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
import { hashBootstrapToken } from './installerBootstrapToken';

function mockParent(overrides: Record<string, unknown> = {}) {
  const parent = {
    id: 'parent-1',
    name: 'Add device installer',
    orgId: 'org-1',
    siteId: 'site-1',
    credentialGeneration: 1,
    maxUsage: null,
    usageCount: 0,
    // deliberately near-dead: the transient 60-min parent, 59 min in
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({
          for: vi.fn().mockResolvedValue([parent]),
        }),
      }),
    }),
  } as any);
  return parent;
}

function mockInsert() {
  let captured: Record<string, unknown> | undefined;
  vi.mocked(db.insert).mockReturnValueOnce({
    values: (v: Record<string, unknown>) => {
      captured = v;
      return {
        returning: async () => [{ id: 'tok-1', ...v }],
      };
    },
  } as any);
  return () => captured;
}

describe('issueBootstrapTokenForKey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // vi.clearAllMocks clears call history but NOT implementations — restore
    // the permissive default every test.
    clampTtlToCapMock.mockReset();
    clampTtlToCapMock.mockImplementation(async (_orgId: string, ttlMinutes: number) => ttlMinutes);
  });

  it('snapshots the SHARE-locked parent credential generation onto the token', async () => {
    mockParent({ credentialGeneration: 7 });
    const insertedValues = mockInsert();

    await issueBootstrapTokenForKey({
      parentEnrollmentKeyId: 'parent-1',
      createdByUserId: 'user-1',
      usageKind: 'capacity',
    });

    expect(insertedValues()).toEqual(
      expect.objectContaining({
        parentEnrollmentKeyId: 'parent-1',
        parentCredentialGeneration: 7,
      }),
    );
  });

  it('stores only the keyed hash of the token, never the plaintext, and returns the raw token once', async () => {
    mockParent();
    const insertedValues = mockInsert();

    const result = await issueBootstrapTokenForKey({
      parentEnrollmentKeyId: 'parent-1',
      createdByUserId: 'user-1',
      usageKind: 'per_download',
      installerPlatform: 'windows',
    });

    const values = insertedValues()!;
    expect(result.token).toMatch(/^[A-Z0-9]{10}$/);
    expect(values.tokenHash).toBe(hashBootstrapToken(result.token));
    expect(values.token ?? null).toBeNull();
    expect(JSON.stringify(values)).not.toContain(result.token);
  });

  it('honours ttlMinutes even when the parent expires sooner (#2775)', async () => {
    mockParent();
    mockInsert();

    const result = await issueBootstrapTokenForKey({
      parentEnrollmentKeyId: 'parent-1',
      createdByUserId: 'user-1',
      usageKind: "capacity",
      maxUsage: 5,
      ttlMinutes: 10080, // 7 days
    });

    const ttlMs = result.expiresAt.getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(10080 * 60 * 1000 - 60_000);
  });

  it('falls back to the 7-day base TTL when ttlMinutes is omitted', async () => {
    mockParent();
    mockInsert();

    const result = await issueBootstrapTokenForKey({
      parentEnrollmentKeyId: 'parent-1',
      createdByUserId: 'user-1',
      usageKind: "capacity",
    });

    const ttlMs = result.expiresAt.getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(10080 * 60 * 1000 - 60_000);
    expect(ttlMs).toBeLessThanOrEqual(10080 * 60 * 1000);
  });

  // Interactive routes reject an explicit ttlMinutes above 30 days with a 400
  // before calling this; the clamp here is defense in depth for callers that
  // pass a derived lifetime (an installer link's remaining time).
  it.each([129600, 525600])(
    'never issues a token living longer than 30 days, even when %i minutes is passed',
    async (ttlMinutes) => {
      mockParent();
      const insertedValues = mockInsert();

      const result = await issueBootstrapTokenForKey({
        parentEnrollmentKeyId: 'parent-1',
        createdByUserId: 'user-1',
        usageKind: "capacity",
        ttlMinutes,
      });

      const ttlMs = result.expiresAt.getTime() - Date.now();
      expect(ttlMs).toBeLessThanOrEqual(43200 * 60 * 1000);
      expect(ttlMs).toBeGreaterThan(43200 * 60 * 1000 - 60_000);
      expect(insertedValues()!.expiresAt).toEqual(result.expiresAt);
      // The partner cap is consulted with the already-bounded value.
      expect(clampTtlToCapMock).toHaveBeenCalledWith('org-1', 43200);
    },
  );

  // The expiry is built from ONE clock read, after the partner cap has been
  // applied in whole minutes — there is no Date -> minutes -> Date round trip
  // to drift or round. Date.now is stubbed to advance a few ms per call so
  // any extra read inside the function would show up in the result.
  it('builds the expiry from a single clock read (no round-trip drift)', async () => {
    mockParent();
    mockInsert();

    const t0 = Date.now();
    let nowCalls = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => t0 + nowCalls++ * 7);

    try {
      const result = await issueBootstrapTokenForKey({
        parentEnrollmentKeyId: 'parent-1',
        createdByUserId: 'user-1',
        usageKind: "capacity",
        ttlMinutes: 1440,
      });

      expect(clampTtlToCapMock).toHaveBeenCalledWith('org-1', 1440);
      expect(result.expiresAt.getTime()).toBe(t0 + 1440 * 60 * 1000);
    } finally {
      nowSpy.mockRestore();
    }
  });

  // The previous minute-quantised round trip left a cap one minute below the
  // request NON-binding (up to 60 s over the cap). Cap and request are now
  // both whole minutes, so the cap binds exactly.
  it('a cap one minute below the request binds exactly', async () => {
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
        usageKind: "capacity",
        ttlMinutes: 1440,
      });

      expect(clampTtlToCapMock).toHaveBeenCalledWith('org-1', 1440);
      expect(result.expiresAt.getTime()).toBe(t0 + 1439 * 60 * 1000);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('passes the configured base to the partner cap in whole minutes when ttlMinutes is omitted', async () => {
    mockParent();
    mockInsert();

    await issueBootstrapTokenForKey({
      parentEnrollmentKeyId: 'parent-1',
      createdByUserId: 'user-1',
      usageKind: "capacity",
    });

    expect(clampTtlToCapMock).toHaveBeenCalledWith('org-1', 10080);
  });

  it.each([0, -5, Number.NaN])(
    'never inserts an expired or invalid expiry for a degenerate ttlMinutes (%s)',
    async (ttlMinutes) => {
      mockParent();
      const insertedValues = mockInsert();

      const result = await issueBootstrapTokenForKey({
        parentEnrollmentKeyId: 'parent-1',
        createdByUserId: 'user-1',
        usageKind: "per_download",
        ttlMinutes,
      });

      const expiresAt = insertedValues()!.expiresAt as Date;
      expect(Number.isNaN(expiresAt.getTime())).toBe(false);
      expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(result.expiresAt).toEqual(expiresAt);
    },
  );

  // Fix round 3 (#2776): a defensive CLAMP (never a rejection) so the
  // partner cap can't be bypassed by a caller that forgets to check it —
  // in particular serveInstaller's unauthenticated public-download path,
  // which passes no ttlMinutes at all and had no cap consult anywhere in
  // its call chain before this fix.
  it('clamps the base TTL down when the partner cap is below it', async () => {
    mockParent();
    mockInsert();
    clampTtlToCapMock.mockImplementation(async (_orgId: string, ttlMinutes: number) =>
      Math.min(ttlMinutes, 60), // partner cap: 60 minutes
    );

    const result = await issueBootstrapTokenForKey({
      parentEnrollmentKeyId: 'parent-1',
      createdByUserId: 'user-1',
      usageKind: "capacity",
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
      usageKind: "capacity",
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
      usageKind: "capacity",
      ttlMinutes: 10080, // 7 days
    });

    const ttlMs = result.expiresAt.getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(10080 * 60 * 1000 - 60_000);
  });
});
