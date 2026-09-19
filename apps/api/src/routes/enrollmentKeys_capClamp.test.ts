/**
 * Direct coverage for two exported helpers in `enrollmentKeys.ts` whose real
 * implementations had NO prior test coverage — every existing test file that
 * imports them (`sendDeploymentInvites.test.ts`, `aiGuardrails.bootstrapParity.test.ts`,
 * `inviteLandingRoutes.test.ts`) mocks them away wholesale as black boxes.
 * That gap is exactly how the fix-round-3 finding shipped: neither function
 * had ever run its real TTL arithmetic under test.
 *
 * Fix round 3 (#2776): `maxEnrollmentLinkTtlMinutes` is a ceiling on KEY
 * LIFETIME, not just interactively-chosen caller input. Both helpers here
 * mint enrollment credentials from a server-constant/parameter default with
 * no interactive caller to reject — so both must CLAMP (never reject) via
 * `clampTtlToCap`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../db/schema', () => ({
  enrollmentKeys: {
    id: 'enrollmentKeys.id',
    orgId: 'enrollmentKeys.orgId',
    siteId: 'enrollmentKeys.siteId',
    shortCode: 'enrollmentKeys.shortCode',
    name: 'enrollmentKeys.name',
    key: 'enrollmentKeys.key',
    keySecretHash: 'enrollmentKeys.keySecretHash',
    maxUsage: 'enrollmentKeys.maxUsage',
    usageCount: 'enrollmentKeys.usageCount',
    expiresAt: 'enrollmentKeys.expiresAt',
    createdAt: 'enrollmentKeys.createdAt',
    createdBy: 'enrollmentKeys.createdBy',
    installerPlatform: 'enrollmentKeys.installerPlatform',
  },
}));

vi.mock('../db/schema/orgs', () => ({
  sites: { id: 'sites.id', orgId: 'sites.orgId', createdAt: 'sites.createdAt' },
  enrollmentKeys: {
    id: 'enrollmentKeys.id',
    orgId: 'enrollmentKeys.orgId',
    siteId: 'enrollmentKeys.siteId',
    shortCode: 'enrollmentKeys.shortCode',
  },
  organizations: { id: 'organizations.id', partnerId: 'organizations.partnerId', createdAt: 'organizations.createdAt' },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../services/permissions', () => ({
  PERMISSIONS: { ORGS_READ: { resource: 'orgs', action: 'read' }, ORGS_WRITE: { resource: 'orgs', action: 'write' } },
}));

vi.mock('../services/auditService', () => ({ createAuditLogAsync: vi.fn() }));

vi.mock('../services/enrollmentKeySecurity', () => ({
  hashEnrollmentKey: vi.fn((key: string) => `hashed:${key}`),
  hashEnrollmentKeyCandidates: vi.fn((key: string) => [`hashed:${key}`]),
}));

vi.mock('../services/installerBuilder', () => ({
  buildMacosInstallerZip: vi.fn(),
  fetchRegularMsi: vi.fn(),
  assertMacosInstallerPkgsReachable: vi.fn(),
  fetchMacosInstallerAppZip: vi.fn(async () => null),
  serveWindowsBootstrapMsi: vi.fn(),
}));

vi.mock('../services/installerAppZip', () => ({ renameAppInZip: vi.fn() }));

vi.mock('../services/installerBootstrapTokenIssuance', () => ({
  issueBootstrapTokenForKey: vi.fn(),
  BootstrapTokenIssuanceError: class BootstrapTokenIssuanceError extends Error {
    code: string;
    constructor(code: string, msg: string) { super(msg); this.code = code; }
  },
}));

vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));

// Partner-cap enforcement (#2776 fix round 3). Mocked at the wiring level —
// see enrollmentKeys.test.ts's identically-named helper for rationale.
const clampTtlToCapMock = vi.fn(
  async (_orgId: string, ttlMinutes: number) => ttlMinutes,
);
vi.mock('../services/enrollmentDefaults', () => ({
  clampTtlToCap: (...args: [string, number]) => clampTtlToCapMock(...args),
}));

import { db } from '../db';
import { mintChildEnrollmentKey, redeemShortCode } from './enrollmentKeys';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const PARTNER_ID = '22222222-2222-4222-8222-222222222222';
const SITE_ID = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  vi.clearAllMocks();
  clampTtlToCapMock.mockReset();
  clampTtlToCapMock.mockImplementation(async (_orgId: string, ttlMinutes: number) => ttlMinutes);
});

describe('mintChildEnrollmentKey (fix round 3, #2776)', () => {
  /** Queue the allocateShortCode uniqueness probe (empty = code is free). */
  function mockShortCodeProbe() {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
      }),
    } as any);
  }

  function mockInsertCapture(): () => any {
    let captured: any;
    vi.mocked(db.insert).mockReturnValueOnce({
      values: vi.fn((v: any) => {
        captured = v;
        return { returning: vi.fn().mockResolvedValue([{ id: 'child-1', ...v }]) };
      }),
    } as any);
    return () => captured;
  }

  it('clamps expiresInSeconds down when the partner cap is below it', async () => {
    clampTtlToCapMock.mockImplementation(async (_orgId: string, ttlMinutes: number) =>
      Math.min(ttlMinutes, 60), // partner cap: 60 minutes
    );
    mockShortCodeProbe();
    const getInserted = mockInsertCapture();

    const before = Date.now();
    const result = await mintChildEnrollmentKey({
      partnerId: PARTNER_ID,
      orgId: ORG_ID,
      siteId: SITE_ID,
      expiresInSeconds: 7 * 24 * 60 * 60, // 7 days — the real MCP tool's constant
    });
    const after = Date.now();

    // Clamped to the 60-minute cap, NOT the requested 7 days.
    expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 59 * 60 * 1000);
    expect(result.expiresAt.getTime()).toBeLessThanOrEqual(after + 60 * 60 * 1000 + 5_000);
    const inserted = getInserted();
    expect(inserted.expiresAt.getTime()).toBe(result.expiresAt.getTime());
    expect(clampTtlToCapMock).toHaveBeenCalledWith(ORG_ID, 7 * 24 * 60); // seconds -> minutes
  });

  it('does not change the lifetime when the partner cap is above the requested value (no-op clamp)', async () => {
    clampTtlToCapMock.mockImplementation(async (_orgId: string, ttlMinutes: number) =>
      Math.min(ttlMinutes, 525_600), // generous partner cap
    );
    mockShortCodeProbe();
    const getInserted = mockInsertCapture();

    const before = Date.now();
    const result = await mintChildEnrollmentKey({
      partnerId: PARTNER_ID,
      orgId: ORG_ID,
      siteId: SITE_ID,
      expiresInSeconds: 7 * 24 * 60 * 60, // 7 days
    });
    const after = Date.now();

    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(before + sevenDaysMs - 60_000);
    expect(result.expiresAt.getTime()).toBeLessThanOrEqual(after + sevenDaysMs + 60_000);
    expect(getInserted().expiresAt.getTime()).toBe(result.expiresAt.getTime());
  });

  it('clamps the CHILD_ENROLLMENT_KEY_TTL_MINUTES default down when expiresInSeconds is omitted', async () => {
    clampTtlToCapMock.mockImplementation(async (_orgId: string, ttlMinutes: number) =>
      Math.min(ttlMinutes, 60), // partner cap: 60 minutes
    );
    mockShortCodeProbe();
    const getInserted = mockInsertCapture();

    const before = Date.now();
    const result = await mintChildEnrollmentKey({
      partnerId: PARTNER_ID,
      orgId: ORG_ID,
      siteId: SITE_ID,
      // no expiresInSeconds — falls back to CHILD_ENROLLMENT_KEY_TTL_MINUTES (43200)
    });
    const after = Date.now();

    expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 59 * 60 * 1000);
    expect(result.expiresAt.getTime()).toBeLessThanOrEqual(after + 60 * 60 * 1000 + 5_000);
    expect(getInserted().expiresAt.getTime()).toBe(result.expiresAt.getTime());
    expect(clampTtlToCapMock).toHaveBeenCalledWith(ORG_ID, 43200);
  });

  // Fix round 4 (#2776): the seconds -> minutes conversion used Math.ceil, which
  // rounds a sub-minute request UP and therefore LENGTHENS the key's lifetime
  // (90s -> 120s) inside the very function that exists to bound it. Floor is the
  // only fail-closed direction here.
  it('rounds a sub-minute expiresInSeconds DOWN, never up (90s must not become 120s)', async () => {
    mockShortCodeProbe();
    const getInserted = mockInsertCapture();

    const before = Date.now();
    const result = await mintChildEnrollmentKey({
      partnerId: PARTNER_ID,
      orgId: ORG_ID,
      siteId: SITE_ID,
      expiresInSeconds: 90,
    });
    const after = Date.now();

    expect(clampTtlToCapMock).toHaveBeenCalledWith(ORG_ID, 1);
    // 60s, not the 120s Math.ceil produced.
    expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 60_000);
    expect(result.expiresAt.getTime()).toBeLessThanOrEqual(after + 60_000);
    expect(result.expiresAt.getTime()).toBeLessThan(before + 90_000);
    expect(getInserted().expiresAt.getTime()).toBe(result.expiresAt.getTime());
  });

  it('floors a below-one-minute expiresInSeconds to 1 minute rather than minting an already-expired key', async () => {
    mockShortCodeProbe();
    const getInserted = mockInsertCapture();

    const before = Date.now();
    const result = await mintChildEnrollmentKey({
      partnerId: PARTNER_ID,
      orgId: ORG_ID,
      siteId: SITE_ID,
      expiresInSeconds: 30,
    });

    expect(clampTtlToCapMock).toHaveBeenCalledWith(ORG_ID, 1);
    expect(result.expiresAt.getTime()).toBeGreaterThan(before);
    expect(getInserted().expiresAt.getTime()).toBe(result.expiresAt.getTime());
  });
});

describe('redeemShortCode (fix round 3, #2776)', () => {
  function mockParentLookup(overrides: Record<string, unknown> = {}) {
    const parent = {
      id: 'parent-1',
      orgId: ORG_ID,
      siteId: SITE_ID,
      name: 'Invite parent',
      keySecretHash: null,
      maxUsage: null,
      usageCount: 0,
      installerPlatform: 'windows',
      expiresAt: new Date(Date.now() + 3_600_000),
      ...overrides,
    };
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([parent]) }),
      }),
    } as any);
    return parent;
  }

  function mockChildInsertCapture(): () => any {
    let captured: any;
    vi.mocked(db.insert).mockReturnValueOnce({
      values: vi.fn((v: any) => {
        captured = v;
        return { returning: vi.fn().mockResolvedValue([{ id: 'child-2', ...v }]) };
      }),
    } as any);
    return () => captured;
  }

  function mockClaimSuccess() {
    vi.mocked(db.update).mockReturnValueOnce({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'parent-1' }]) }),
      }),
    } as any);
  }

  it('clamps the invite child key TTL down when the partner cap is below the default', async () => {
    clampTtlToCapMock.mockImplementation(async (_orgId: string, ttlMinutes: number) =>
      Math.min(ttlMinutes, 60), // partner cap: 60 minutes
    );
    mockParentLookup();
    const getInserted = mockChildInsertCapture();
    mockClaimSuccess();

    const before = Date.now();
    const result = await redeemShortCode('abc123');
    const after = Date.now();

    expect(result).not.toBeNull();
    const inserted = getInserted();
    expect(inserted.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 59 * 60 * 1000);
    expect(inserted.expiresAt.getTime()).toBeLessThanOrEqual(after + 60 * 60 * 1000 + 5_000);
    expect(clampTtlToCapMock).toHaveBeenCalledWith(ORG_ID, 43200);
  });

  it('does not shorten the invite child key TTL when the partner cap is above the default (no-op clamp)', async () => {
    clampTtlToCapMock.mockImplementation(async (_orgId: string, ttlMinutes: number) =>
      Math.min(ttlMinutes, 525_600), // generous partner cap
    );
    mockParentLookup();
    const getInserted = mockChildInsertCapture();
    mockClaimSuccess();

    const before = Date.now();
    const result = await redeemShortCode('def456');
    const after = Date.now();

    expect(result).not.toBeNull();
    const inserted = getInserted();
    expect(inserted.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 43199 * 60 * 1000);
    expect(inserted.expiresAt.getTime()).toBeLessThanOrEqual(after + 43201 * 60 * 1000);
  });
});
