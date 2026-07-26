/**
 * Tests for getEnrollmentDefaultsForOrg — the DB read that resolves the
 * effective enrollment link defaults (TTL, device count, TTL cap) for an org
 * against its partner in a single org⋈partner join (issue #2776).
 *
 * Mirrors the mock harness in helpers.agentUpdatePolicy.test.ts: a single-call
 * db.select chain queue, since the resolver here issues exactly one joined
 * SELECT. Real schema module is left unmocked (no import-time side effects);
 * only `../db` needs mocking, since it opens a real Postgres connection at
 * module load.
 *
 * IMPORTANT LIMITATION (fix round 1, #2776): a mocked-DB unit test CANNOT
 * prove that an org-scoped caller actually sees the partner's cap — that
 * requires real Postgres RLS to deny/allow the `partners` row, which no mock
 * can emulate. These tests only prove the WIRING: that the read runs via
 * runOutsideDbContext(withSystemDbAccessContext(...)) rather than directly
 * against whatever context is already ambient. The behavioral proof against
 * a real org-scoped RLS context lives in the integration test:
 * apps/api/src/__tests__/integration/enrollmentDefaultsPartnerCap.integration.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  dbMock,
  runOutsideDbContextMock,
  withSystemDbAccessContextMock,
  getCurrentDbAccessContextMock,
} = vi.hoisted(() => {
  let nextResult: unknown[] = [];

  const makeSelectChain = () => {
    const chain: any = {
      from: vi.fn(() => chain),
      leftJoin: vi.fn(() => chain),
      where: vi.fn(() => chain),
      limit: vi.fn(() => Promise.resolve(nextResult)),
    };
    chain.then = (resolve: any, reject: any) => Promise.resolve(nextResult).then(resolve, reject);
    return chain;
  };

  const dbMock = {
    select: vi.fn(() => makeSelectChain()),
    _setResult(rows: unknown[]) {
      nextResult = rows;
    },
  };

  // Pass-through mocks that still let assertions verify they were invoked —
  // real behavior (exiting the ALS context, setting RLS GUCs) can't be
  // exercised without a real DB; see the integration test for that proof.
  const runOutsideDbContextMock = vi.fn((fn: () => unknown) => fn());
  const withSystemDbAccessContextMock = vi.fn((fn: () => unknown) => fn());
  // Ambient DbAccessContext metadata. Default: no context at all (background /
  // contextless caller), which must take the escape just like an org-scoped one.
  const getCurrentDbAccessContextMock = vi.fn((): unknown => undefined);

  return {
    dbMock,
    runOutsideDbContextMock,
    withSystemDbAccessContextMock,
    getCurrentDbAccessContextMock,
  };
});

vi.mock('../db', () => ({
  db: dbMock,
  runOutsideDbContext: runOutsideDbContextMock,
  withSystemDbAccessContext: withSystemDbAccessContextMock,
  getCurrentDbAccessContext: getCurrentDbAccessContextMock,
}));

import { getEnrollmentDefaultsForOrg, assertTtlWithinCap, clampTtlToCap } from './enrollmentDefaults';

const ORG_ID = '00000000-0000-4000-8000-000000000001';

/** Stand-in for the metadata AsyncLocalStorage store of an active context. */
function ambientContext(scope: 'system' | 'partner' | 'organization'): unknown {
  return {
    scope,
    orgId: scope === 'organization' ? ORG_ID : null,
    accessibleOrgIds: scope === 'organization' ? [ORG_ID] : null,
    accessiblePartnerIds: scope === 'system' ? null : [],
    userId: null,
  };
}

/** Restores the permissive pass-through defaults after vi.clearAllMocks(). */
function resetDbContextMocks(): void {
  runOutsideDbContextMock.mockImplementation((fn: () => unknown) => fn());
  withSystemDbAccessContextMock.mockImplementation((fn: () => unknown) => fn());
  getCurrentDbAccessContextMock.mockImplementation(() => undefined);
}

/** Seed the single org⋈partner join row that the resolver reads. */
function mockJoinRow(opts: { orgSettings?: unknown; partnerSettings?: unknown } = {}): void {
  dbMock._setResult([
    { orgSettings: opts.orgSettings ?? null, partnerSettings: opts.partnerSettings ?? null },
  ]);
}

describe('getEnrollmentDefaultsForOrg', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbContextMocks();
  });

  // Fix round 1 (#2776): the partner-axis join must run in a system context,
  // exited from any ambient request context first — otherwise an org-scoped
  // caller's empty accessible_partner_ids makes `partners` invisible under
  // RLS and the cap silently evaporates. This proves the WIRING only (both
  // helpers are mocked pass-throughs here); the real RLS behavior is proven
  // against Postgres in the integration test referenced at the top of this file.
  it('reads the org⋈partner join via runOutsideDbContext(withSystemDbAccessContext(...))', async () => {
    mockJoinRow({});
    await getEnrollmentDefaultsForOrg(ORG_ID);
    expect(runOutsideDbContextMock).toHaveBeenCalledTimes(1);
    expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(1);
  });

  // Fix round 4 (#2776) — AVAILABILITY. withDbAccessContext opens a real
  // transaction, so it pins one pooled connection for its whole callback;
  // runOutsideDbContext exits the ALS store, so the nested system context does
  // NOT nest — it takes a SECOND connection while the first is still held. On
  // paths already inside a system context (POST /installer/bootstrap, /s/:code,
  // /public-download) that double-hold is pure downside: `partners` is already
  // visible. At N concurrent requests >= DB_POOL_MAX every connection is held
  // by a request queued for one only a peer can release, and postgres-js has no
  // acquire timeout — the API stalls indefinitely.
  //
  // These assert the MECHANISM (which context helpers ran), not just the
  // returned number: the two code paths are indistinguishable by value alone.
  describe('ambient-context branch', () => {
    it('reads in the AMBIENT context — opening no second context — when the caller is already system-scoped', async () => {
      getCurrentDbAccessContextMock.mockImplementation(() => ambientContext('system'));
      mockJoinRow({ partnerSettings: { defaults: { maxEnrollmentLinkTtlMinutes: 1440 } } });

      const r = await getEnrollmentDefaultsForOrg(ORG_ID);

      // Same cap resolved...
      expect(r.maxTtlMinutes).toBe(1440);
      // ...via exactly one SELECT on the connection the caller already holds.
      expect(dbMock.select).toHaveBeenCalledTimes(1);
      expect(runOutsideDbContextMock).not.toHaveBeenCalled();
      expect(withSystemDbAccessContextMock).not.toHaveBeenCalled();
    });

    it('still escapes to a fresh system context for an ORG-scoped caller (the round-1 RLS fix must not regress)', async () => {
      getCurrentDbAccessContextMock.mockImplementation(() => ambientContext('organization'));
      mockJoinRow({ partnerSettings: { defaults: { maxEnrollmentLinkTtlMinutes: 1440 } } });

      const r = await getEnrollmentDefaultsForOrg(ORG_ID);

      expect(r.maxTtlMinutes).toBe(1440);
      expect(runOutsideDbContextMock).toHaveBeenCalledTimes(1);
      expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(1);
    });

    it('still escapes for a PARTNER-scoped caller (partner scope sees only its OWN partner row, not an arbitrary org’s)', async () => {
      getCurrentDbAccessContextMock.mockImplementation(() => ambientContext('partner'));
      mockJoinRow({});

      await getEnrollmentDefaultsForOrg(ORG_ID);

      expect(runOutsideDbContextMock).toHaveBeenCalledTimes(1);
      expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(1);
    });

    it('still escapes when there is no ambient context at all (background/worker caller)', async () => {
      getCurrentDbAccessContextMock.mockImplementation(() => undefined);
      mockJoinRow({});

      await getEnrollmentDefaultsForOrg(ORG_ID);

      expect(runOutsideDbContextMock).toHaveBeenCalledTimes(1);
      expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(1);
    });
  });

  it('resolves org-over-partner for the TTL default', async () => {
    mockJoinRow({
      orgSettings: { defaults: { defaultEnrollmentTtlMinutes: 60 } },
      partnerSettings: { defaults: { defaultEnrollmentTtlMinutes: 10080 } },
    });
    const r = await getEnrollmentDefaultsForOrg(ORG_ID);
    expect(r.ttlMinutes).toBe(60);
  });

  it('inherits the partner TTL default when the org has not set one', async () => {
    mockJoinRow({
      orgSettings: { defaults: {} },
      partnerSettings: { defaults: { defaultEnrollmentTtlMinutes: 10080 } },
    });
    const r = await getEnrollmentDefaultsForOrg(ORG_ID);
    expect(r.ttlMinutes).toBe(10080);
  });

  it('ignores an org attempt to raise the partner cap', async () => {
    mockJoinRow({
      orgSettings: { defaults: { maxEnrollmentLinkTtlMinutes: 525600 } },
      partnerSettings: { defaults: { maxEnrollmentLinkTtlMinutes: 1440 } },
    });
    const r = await getEnrollmentDefaultsForOrg(ORG_ID);
    expect(r.maxTtlMinutes).toBe(1440);
  });

  it('falls back to product defaults when neither org nor partner has settings', async () => {
    mockJoinRow({});
    const r = await getEnrollmentDefaultsForOrg(ORG_ID);
    expect(r).toEqual({ ttlMinutes: 1440, deviceCount: 1, maxTtlMinutes: 525600 });
  });

  it('falls back to org-local values when there is no partner row (LEFT JOIN null)', async () => {
    mockJoinRow({
      orgSettings: { defaults: { defaultEnrollmentTtlMinutes: 60, defaultEnrollmentDeviceCount: 5 } },
      partnerSettings: null,
    });
    const r = await getEnrollmentDefaultsForOrg(ORG_ID);
    expect(r).toEqual({ ttlMinutes: 60, deviceCount: 5, maxTtlMinutes: 525600 });
  });

  it('propagates a DB error rather than swallowing it', async () => {
    dbMock.select.mockImplementationOnce(() => {
      throw new Error('db down');
    });
    await expect(getEnrollmentDefaultsForOrg(ORG_ID)).rejects.toThrow('db down');
  });
});

describe('assertTtlWithinCap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbContextMocks();
  });

  it('returns null (no violation) when ttlMinutes is undefined — an omitted TTL is not a chosen value to reject', async () => {
    const err = await assertTtlWithinCap(ORG_ID, undefined);
    expect(err).toBeNull();
    // Must not even consult the resolver for an absent value.
    expect(dbMock.select).not.toHaveBeenCalled();
  });

  it('rejects an explicit ttlMinutes above the partner cap, naming the cap', async () => {
    mockJoinRow({ partnerSettings: { defaults: { maxEnrollmentLinkTtlMinutes: 1440 } } });
    const err = await assertTtlWithinCap(ORG_ID, 43200);
    expect(err).toBe('ttlMinutes exceeds the partner maximum of 1440 minutes');
  });

  it('allows an explicit ttlMinutes exactly at the cap', async () => {
    mockJoinRow({ partnerSettings: { defaults: { maxEnrollmentLinkTtlMinutes: 1440 } } });
    const err = await assertTtlWithinCap(ORG_ID, 1440);
    expect(err).toBeNull();
  });

  it('allows an explicit ttlMinutes under the product-default cap when the partner sets none', async () => {
    mockJoinRow({});
    const err = await assertTtlWithinCap(ORG_ID, 129600);
    expect(err).toBeNull();
  });
});

/**
 * Direct coverage for clampTtlToCap (fix round 4, #2776). Until now every test
 * that touched it mocked it away, so its own arithmetic — and its "always
 * returns a number, never rejects" contract — had never actually run under
 * test. It is the enforcement point for every non-interactive path (device
 * enrollment redemption, public downloads, MCP invites), so a silent inversion
 * here would uncap those paths with nothing to catch it.
 */
describe('clampTtlToCap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbContextMocks();
  });

  it('clamps a TTL above the partner cap down to the cap', async () => {
    mockJoinRow({ partnerSettings: { defaults: { maxEnrollmentLinkTtlMinutes: 1440 } } });
    await expect(clampTtlToCap(ORG_ID, 43200)).resolves.toBe(1440);
  });

  it('leaves a TTL below the cap untouched', async () => {
    mockJoinRow({ partnerSettings: { defaults: { maxEnrollmentLinkTtlMinutes: 1440 } } });
    await expect(clampTtlToCap(ORG_ID, 60)).resolves.toBe(60);
  });

  it('is a no-op at exactly the cap (boundary is inclusive, matching assertTtlWithinCap)', async () => {
    mockJoinRow({ partnerSettings: { defaults: { maxEnrollmentLinkTtlMinutes: 1440 } } });
    await expect(clampTtlToCap(ORG_ID, 1440)).resolves.toBe(1440);
  });

  it('falls back to the product-default cap when no partner cap is configured', async () => {
    mockJoinRow({});
    await expect(clampTtlToCap(ORG_ID, 129600)).resolves.toBe(129600);
    mockJoinRow({});
    await expect(clampTtlToCap(ORG_ID, 999999)).resolves.toBe(525600);
  });

  it('ignores an org attempt to raise the partner cap', async () => {
    mockJoinRow({
      orgSettings: { defaults: { maxEnrollmentLinkTtlMinutes: 525600 } },
      partnerSettings: { defaults: { maxEnrollmentLinkTtlMinutes: 1440 } },
    });
    await expect(clampTtlToCap(ORG_ID, 43200)).resolves.toBe(1440);
  });

  it('returns a number (never throws / never rejects) for an over-cap value — clamp, not reject', async () => {
    mockJoinRow({ partnerSettings: { defaults: { maxEnrollmentLinkTtlMinutes: 60 } } });
    const result = await clampTtlToCap(ORG_ID, 525600);
    expect(typeof result).toBe('number');
    expect(result).toBe(60);
  });

  it('resolves the SAME cap regardless of the ambient DB access context', async () => {
    // The value must not depend on who is asking — only the plumbing used to
    // read it does (ambient read under system scope, escape otherwise). A
    // regression that made the cap context-dependent is exactly the round-1
    // Critical (org-scoped callers silently seeing the permissive global max).
    const results: number[] = [];
    for (const scope of ['system', 'partner', 'organization'] as const) {
      getCurrentDbAccessContextMock.mockImplementation(() => ambientContext(scope));
      mockJoinRow({ partnerSettings: { defaults: { maxEnrollmentLinkTtlMinutes: 1440 } } });
      results.push(await clampTtlToCap(ORG_ID, 43200));
    }
    getCurrentDbAccessContextMock.mockImplementation(() => undefined);
    mockJoinRow({ partnerSettings: { defaults: { maxEnrollmentLinkTtlMinutes: 1440 } } });
    results.push(await clampTtlToCap(ORG_ID, 43200));

    expect(results).toEqual([1440, 1440, 1440, 1440]);
  });
});
