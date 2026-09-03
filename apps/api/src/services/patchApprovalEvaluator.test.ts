import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  db: { select: vi.fn() },
}));

vi.mock('../db/schema', () => ({
  devicePatches: { id: 'id', patchId: 'patchId', deviceId: 'deviceId', status: 'status', createdAt: 'createdAt' },
  patches: {
    id: 'id', externalId: 'externalId', title: 'title', category: 'category',
    severity: 'severity', releaseDate: 'releaseDate', requiresReboot: 'requiresReboot',
    source: 'source', packageId: 'packageId', version: 'version',
  },
  patchApprovals: { patchId: 'patchId', status: 'status', ringId: 'ringId', partnerId: 'partnerId' },
  organizations: { id: 'id', partnerId: 'partnerId' },
  OUTSTANDING_DEVICE_PATCH_STATUSES: ['pending'],
}));

import { db } from '../db';
import {
  appRuleKey,
  buildAppRuleMap,
  buildAllowedPatchSources,
  comparePatchVersions,
  evaluateAppRule,
  isCategoryAllowed,
  parseRingAutoApprove,
  resolveApprovedPatchesForDevice,
  THIRD_PARTY_PATCH_SOURCES,
  type ApprovalEvaluationConfig,
  type RingConfig,
} from './patchApprovalEvaluator';

// Compile-time checks: deprecated alias and exported source list stay usable.
const _aliasCheck: RingConfig = { ringId: null, categoryRules: [], autoApprove: {}, deferralDays: 0 };
const _aliasCheck2: ApprovalEvaluationConfig = _aliasCheck;
void _aliasCheck2;
void THIRD_PARTY_PATCH_SOURCES;

describe('comparePatchVersions', () => {
  it.each([
    ['1.2.3', '1.2.3', 0],
    ['1.2.10', '1.2.9', 1],
    ['1.2', '1.2.0', 0],
    ['3.0.20', '3.0.21', -1],
    ['2024.1', '2024.1.5', -1],
    ['1.2.3-beta', '1.2.3-alpha', 1],
  ])('compare(%s, %s) === %i', (a, b, expected) => {
    expect(comparePatchVersions(a, b)).toBe(expected);
  });

  it('returns null when either side is missing or blank', () => {
    expect(comparePatchVersions(null, '1.0')).toBeNull();
    expect(comparePatchVersions('1.0', undefined)).toBeNull();
    expect(comparePatchVersions('  ', '1.0')).toBeNull();
  });
});

describe('appRuleKey', () => {
  it('collapses third_party and custom into one canonical bucket', () => {
    expect(appRuleKey('third_party', 'Mozilla.Firefox')).toBe('third_party|mozilla.firefox');
    expect(appRuleKey('custom', 'Mozilla.Firefox')).toBe('third_party|mozilla.firefox');
  });

  it('keeps non-third-party sources as their own bucket', () => {
    expect(appRuleKey('microsoft', 'SomeId')).toBe('microsoft|someid');
  });
});

describe('evaluateAppRule', () => {
  const rules = buildAppRuleMap([
    { source: 'third_party', packageId: 'Mozilla.Firefox', action: 'block' },
    { source: 'third_party', packageId: 'VideoLAN.VLC', action: 'pin', pinnedVersion: '3.0.20' },
  ]);

  it('blocks a matching block rule case-insensitively', () => {
    expect(evaluateAppRule({ source: 'third_party', packageId: 'mozilla.firefox', version: '120.0' }, rules)).toBe('blocked');
  });

  it('allows patches with no matching rule or no packageId', () => {
    expect(evaluateAppRule({ source: 'third_party', packageId: 'Notepad++.Notepad++', version: '8.6' }, rules)).toBe('allowed');
    expect(evaluateAppRule({ source: 'microsoft', packageId: null, version: null }, rules)).toBe('allowed');
  });

  it('holds a pinned app when the target version exceeds the pin', () => {
    expect(evaluateAppRule({ source: 'third_party', packageId: 'VideoLAN.VLC', version: '3.0.21' }, rules)).toBe('held');
  });

  it('allows a pinned app at or below the pin', () => {
    expect(evaluateAppRule({ source: 'third_party', packageId: 'VideoLAN.VLC', version: '3.0.20' }, rules)).toBe('allowed');
    expect(evaluateAppRule({ source: 'third_party', packageId: 'VideoLAN.VLC', version: '3.0.19' }, rules)).toBe('allowed');
  });

  it('holds when the patch version is missing', () => {
    expect(evaluateAppRule({ source: 'third_party', packageId: 'VideoLAN.VLC', version: null }, rules)).toBe('held');
  });

  it('a third_party rule also matches a custom-source patch (unified bucket)', () => {
    expect(evaluateAppRule({ source: 'custom', packageId: 'Mozilla.Firefox', version: '120.0' }, rules)).toBe('blocked');
    expect(evaluateAppRule({ source: 'custom', packageId: 'VideoLAN.VLC', version: '3.0.21' }, rules)).toBe('held');
  });

  it('a custom rule also matches a third_party-source patch (unified bucket)', () => {
    const customRules = buildAppRuleMap([
      { source: 'custom', packageId: 'Mozilla.Firefox', action: 'block' },
    ]);
    expect(evaluateAppRule({ source: 'third_party', packageId: 'Mozilla.Firefox', version: '120.0' }, customRules)).toBe('blocked');
  });
});

describe('buildAllowedPatchSources', () => {
  it('maps os to the three OS patch sources', () => {
    expect(buildAllowedPatchSources(['os'])).toEqual(new Set(['microsoft', 'apple', 'linux']));
  });

  it('maps third_party to third_party and custom', () => {
    expect(buildAllowedPatchSources(['third_party'])).toEqual(new Set(['third_party', 'custom']));
  });

  it('passes through explicit patch-source values', () => {
    expect(buildAllowedPatchSources(['microsoft', 'custom'])).toEqual(new Set(['microsoft', 'custom']));
  });

  it('ignores firmware/drivers (no provider exists) without blocking other sources', () => {
    expect(buildAllowedPatchSources(['os', 'firmware', 'drivers'])).toEqual(
      new Set(['microsoft', 'apple', 'linux'])
    );
  });

  it('returns null (no filtering) for undefined or empty input — legacy jobs', () => {
    expect(buildAllowedPatchSources(undefined)).toBeNull();
    expect(buildAllowedPatchSources([])).toBeNull();
  });

  it('returns an empty set (block all) when only unsupported sources are selected', () => {
    expect(buildAllowedPatchSources(['firmware', 'drivers'])).toEqual(new Set());
  });
});

// ---- resolveApprovedPatchesForDevice with mocked Drizzle chains ----

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const DEVICE_ID = '22222222-2222-2222-2222-222222222222';
const RING_ID = '33333333-3333-3333-3333-333333333333';
const PARTNER_ID = '44444444-4444-4444-4444-444444444444';
const OTHER_PARTNER_ID = '55555555-5555-5555-5555-555555555555';
const P1 = 'aaaaaaaa-0000-0000-0000-000000000001';
const P2 = 'aaaaaaaa-0000-0000-0000-000000000002';

type PendingRow = {
  devicePatchId: string;
  patchId: string;
  externalId: string;
  title: string;
  category: string | null;
  severity: string | null;
  releaseDate: string | null;
  requiresReboot: boolean;
  source: string;
  packageId: string | null;
  version: string | null;
  firstSeenAt: Date | null;
};

function pendingRow(overrides: Partial<PendingRow>): PendingRow {
  return {
    devicePatchId: 'dp-1',
    patchId: P1,
    externalId: 'KB0000001',
    title: 'A patch',
    category: 'security',
    severity: 'critical',
    releaseDate: null,
    requiresReboot: false,
    source: 'microsoft',
    packageId: null,
    version: null,
    firstSeenAt: null,
    ...overrides,
  };
}

/**
 * Mock three sequential db.select calls:
 *   1. organizations lookup (org → partnerId)
 *   2. devicePatches + patches join (pending patches)
 *   3. patchApprovals (manual approvals for this partner)
 */
function mockPendingAndApprovals(
  pendingRows: PendingRow[],
  approvalRows: Array<{ patchId: string; status: string; ringId: string | null }>,
  partnerId: string = PARTNER_ID,
) {
  const orgChain: any = {
    from: vi.fn(() => orgChain),
    where: vi.fn(() => orgChain),
    limit: vi.fn(() => Promise.resolve([{ partnerId }])),
  };
  const pendingChain: any = {
    from: vi.fn(() => pendingChain),
    innerJoin: vi.fn(() => pendingChain),
    where: vi.fn(() => Promise.resolve(pendingRows)),
  };
  const approvalChain: any = {
    from: vi.fn(() => approvalChain),
    where: vi.fn(() => Promise.resolve(approvalRows)),
  };
  vi.mocked(db.select)
    .mockReturnValueOnce(orgChain)
    .mockReturnValueOnce(pendingChain)
    .mockReturnValueOnce(approvalChain);
}

// Ring auto-approve fails closed on an empty severity set, so the shared
// fixture must name explicit severities to exercise the approve path. The
// default pendingRow severity is 'critical'; include the others these suites
// vary to so source/app-rule filtering (not the severity gate) is what's under
// test.
const baseRing: RingConfig = {
  ringId: RING_ID,
  categoryRules: [],
  autoApprove: { enabled: true, severities: ['critical', 'important', 'moderate', 'low'] },
  deferralDays: 0,
};

describe('resolveApprovedPatchesForDevice source filtering', () => {
  beforeEach(() => {
    vi.mocked(db.select).mockReset();
  });

  it('excludes third_party and custom patches when sources is ["os"]', async () => {
    mockPendingAndApprovals(
      [
        pendingRow({ patchId: 'aaaaaaaa-0000-0000-0000-000000000001', source: 'microsoft' }),
        pendingRow({ patchId: 'aaaaaaaa-0000-0000-0000-000000000002', source: 'third_party' }),
        pendingRow({ patchId: 'aaaaaaaa-0000-0000-0000-000000000003', source: 'custom' }),
      ],
      []
    );

    const approved = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ...baseRing,
      sources: ['os'],
    });

    expect(approved.map((p) => p.patchId)).toEqual(['aaaaaaaa-0000-0000-0000-000000000001']);
  });

  it('excludes OS patches when sources is ["third_party"]', async () => {
    mockPendingAndApprovals(
      [
        pendingRow({ patchId: 'aaaaaaaa-0000-0000-0000-000000000001', source: 'microsoft' }),
        pendingRow({ patchId: 'aaaaaaaa-0000-0000-0000-000000000002', source: 'apple' }),
        pendingRow({ patchId: 'aaaaaaaa-0000-0000-0000-000000000003', source: 'third_party' }),
      ],
      []
    );

    const approved = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ...baseRing,
      sources: ['third_party'],
    });

    expect(approved.map((p) => p.patchId)).toEqual(['aaaaaaaa-0000-0000-0000-000000000003']);
  });

  it('applies no source filtering to OS patches when sources is absent (legacy jobs), but still refuses third-party (dual consent, #spec 2026-08-04)', async () => {
    // buildAllowedPatchSources itself does not gate on absent sources (legacy
    // "no filtering" jobs), but the ring-level dual-consent check in
    // evaluatePatchApproval requires the literal 'third_party' selection
    // regardless — an absent policy sources array can never satisfy that, so
    // the third-party patch stays unapproved even though its severity matches
    // the ring's OS severity list.
    mockPendingAndApprovals(
      [
        pendingRow({ patchId: 'aaaaaaaa-0000-0000-0000-000000000001', source: 'microsoft' }),
        pendingRow({ patchId: 'aaaaaaaa-0000-0000-0000-000000000002', source: 'third_party' }),
      ],
      []
    );

    const approved = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, baseRing);

    expect(approved.map((p) => p.patchId)).toEqual(['aaaaaaaa-0000-0000-0000-000000000001']);
  });

  it('source filter also gates manually approved patches', async () => {
    mockPendingAndApprovals(
      [pendingRow({ patchId: 'aaaaaaaa-0000-0000-0000-000000000002', source: 'third_party', severity: 'low' })],
      [{ patchId: 'aaaaaaaa-0000-0000-0000-000000000002', status: 'approved', ringId: null }]
    );

    const approved = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: null,
      categoryRules: [],
      autoApprove: {},
      deferralDays: 0,
      sources: ['os'],
    });

    expect(approved).toHaveLength(0);
  });
});

describe('app rules in resolveApprovedPatchesForDevice', () => {
  beforeEach(() => {
    vi.mocked(db.select).mockReset();
  });

  it('excludes a blocked app even when manually approved', async () => {
    mockPendingAndApprovals(
      [pendingRow({ patchId: P1, source: 'third_party', packageId: 'Mozilla.Firefox', version: '121.0' })],
      [{ patchId: P1, status: 'approved', ringId: null }]
    );

    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: null,
      categoryRules: [],
      autoApprove: {},
      deferralDays: 0,
      sources: ['third_party'],
      apps: [{ source: 'third_party', packageId: 'Mozilla.Firefox', action: 'block' }],
    });

    expect(result).toEqual([]);
  });

  it('holds a pinned app above the pin but approves one at the pin', async () => {
    mockPendingAndApprovals(
      [
        pendingRow({ patchId: P1, devicePatchId: 'dp-1', source: 'third_party', packageId: 'VideoLAN.VLC', version: '3.0.21' }),
        pendingRow({ patchId: P2, devicePatchId: 'dp-2', source: 'third_party', packageId: 'VideoLAN.VLC', version: '3.0.20' }),
      ],
      [{ patchId: P1, status: 'approved', ringId: null }, { patchId: P2, status: 'approved', ringId: null }]
    );

    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: null,
      categoryRules: [],
      autoApprove: {},
      deferralDays: 0,
      sources: ['third_party'],
      apps: [{ source: 'third_party', packageId: 'VideoLAN.VLC', action: 'pin', pinnedVersion: '3.0.20' }],
    });

    expect(result.map((r) => r.patchId)).toEqual([P2]);
  });

  it('a third_party block rule excludes a custom-source patch (unified bucket)', async () => {
    mockPendingAndApprovals(
      [pendingRow({ patchId: P1, source: 'custom', packageId: 'Mozilla.Firefox', version: '121.0' })],
      [{ patchId: P1, status: 'approved', ringId: null }]
    );

    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: null,
      categoryRules: [],
      autoApprove: {},
      deferralDays: 0,
      sources: ['third_party'],
      apps: [{ source: 'third_party', packageId: 'Mozilla.Firefox', action: 'block' }],
    });

    expect(result).toEqual([]);
  });

  it('warns but still approves an otherwise-eligible third-party patch with no packageId', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mockPendingAndApprovals(
        [pendingRow({ patchId: P1, source: 'third_party', packageId: null, version: '1.0' })],
        [{ patchId: P1, status: 'approved', ringId: null }]
      );

      const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
        ringId: null,
        categoryRules: [],
        autoApprove: {},
        deferralDays: 0,
        sources: ['third_party'],
        apps: [{ source: 'third_party', packageId: 'VideoLAN.VLC', action: 'pin', pinnedVersion: '3.0.20' }],
      });

      expect(result.map((r) => r.patchId)).toEqual([P1]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('cannot be matched against app rules — missing packageId')
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('applies an app block rule under a linked ring too', async () => {
    mockPendingAndApprovals(
      [
        pendingRow({ patchId: P1, devicePatchId: 'dp-1', source: 'third_party', category: 'third_party_app', packageId: 'Mozilla.Firefox', version: '121.0' }),
        pendingRow({ patchId: P2, devicePatchId: 'dp-2', source: 'third_party', category: 'third_party_app', packageId: 'VideoLAN.VLC', version: '3.0.20' }),
      ],
      []
    );

    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: RING_ID,
      categoryRules: [{ category: 'third_party_app', autoApprove: true }],
      // Dual consent: a category allow rule for a third-party patch requires
      // the same policy-sources + ring-toggle legs as Priority 3.
      autoApprove: { enabled: true, severities: [], thirdPartyApps: true },
      deferralDays: 0,
      sources: ['third_party'],
      apps: [{ source: 'third_party', packageId: 'Mozilla.Firefox', action: 'block' }],
    });

    expect(result.map((r) => r.patchId)).toEqual([P2]);
    expect(result[0]?.approvalReason).toBe('category_rule');
  });
});

describe('category rule canonicalization (definition/definitions)', () => {
  beforeEach(() => {
    vi.mocked(db.select).mockReset();
  });

  const catRing = (categoryRules: RingConfig['categoryRules']): RingConfig => ({
    ringId: RING_ID,
    categoryRules,
    autoApprove: { enabled: false, severities: [] },
    deferralDays: 0,
  });

  it('legacy singular "definition" rule matches the agent\'s "definitions" category', async () => {
    mockPendingAndApprovals(
      [pendingRow({ patchId: P1, devicePatchId: 'dp-1', category: 'definitions', source: 'microsoft' })],
      []
    );

    const result = await resolveApprovedPatchesForDevice(
      DEVICE_ID,
      ORG_ID,
      catRing([{ category: 'definition', autoApprove: true }])
    );

    expect(result.map((r) => r.patchId)).toEqual([P1]);
    expect(result[0]?.approvalReason).toBe('category_rule');
  });

  it('canonical "definitions" rule matches the "definitions" category', async () => {
    mockPendingAndApprovals(
      [pendingRow({ patchId: P1, devicePatchId: 'dp-1', category: 'definitions', source: 'microsoft' })],
      []
    );

    const result = await resolveApprovedPatchesForDevice(
      DEVICE_ID,
      ORG_ID,
      catRing([{ category: 'definitions', autoApprove: true }])
    );

    expect(result[0]?.approvalReason).toBe('category_rule');
  });
});

describe('ring-less path: only manual approvals apply', () => {
  // policyAutoApprove has been removed. With no ring, only partner-wide manual
  // approvals (ring_id NULL) or ring-specific approvals matching null apply.
  beforeEach(() => {
    vi.mocked(db.select).mockReset();
  });

  it('does not auto-approve patches with no ring and no manual approval', async () => {
    mockPendingAndApprovals([pendingRow({ patchId: P1, severity: 'critical', source: 'third_party', packageId: 'X.Y' })], []);

    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: null,
      categoryRules: [],
      autoApprove: {},
      deferralDays: 0,
      sources: ['third_party'],
    });

    expect(result).toHaveLength(0);
  });

  it('approves a ring-less patch via partner-wide manual approval (ring_id NULL)', async () => {
    mockPendingAndApprovals(
      [pendingRow({ patchId: P1, severity: 'critical', source: 'microsoft' })],
      [{ patchId: P1, status: 'approved', ringId: null }],
    );

    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: null,
      categoryRules: [],
      autoApprove: {},
      deferralDays: 0,
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.approvalReason).toBe('manual');
  });

  it('returns [] when no patches are pending', async () => {
    // Even with ring-less config, no pending patches → empty
    mockPendingAndApprovals([], []);

    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: null,
      categoryRules: [],
      autoApprove: {},
      deferralDays: 0,
    });

    expect(result).toEqual([]);
  });

  it('source filter also gates manually approved patches without a ring', async () => {
    mockPendingAndApprovals(
      [pendingRow({ patchId: P2, source: 'third_party', severity: 'low' })],
      [{ patchId: P2, status: 'approved', ringId: null }]
    );

    const approved = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: null,
      categoryRules: [],
      autoApprove: {},
      deferralDays: 0,
      sources: ['os'],
    });

    expect(approved).toHaveLength(0);
  });
});

describe('"third_party_app" as a literal category (virtual source-matching removed, #spec 2026-08-04)', () => {
  beforeEach(() => {
    vi.mocked(db.select).mockReset();
  });

  const ringWithThirdPartyRule: RingConfig = {
    ringId: RING_ID,
    categoryRules: [{ category: 'third_party_app', autoApprove: true }],
    autoApprove: {},
    deferralDays: 0,
  };

  // Dual consent granted (policy sources + ring toggle) so the category rule
  // itself is what each test exercises — without consent a third-party patch
  // is refused before the rule's severity/deferral gates are ever reached.
  const consentedRingWithThirdPartyRule: RingConfig = {
    ringId: RING_ID,
    categoryRules: [{ category: 'third_party_app', autoApprove: true }],
    autoApprove: { enabled: true, severities: [], thirdPartyApps: true },
    deferralDays: 0,
    sources: ['third_party'],
  };

  it('no longer matches a third_party-source patch whose category is not literally "third_party_app"', async () => {
    mockPendingAndApprovals(
      [pendingRow({ patchId: 'aaaaaaaa-0000-0000-0000-000000000010', source: 'third_party', category: 'homebrew-cask' })],
      []
    );

    const approved = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, ringWithThirdPartyRule);

    expect(approved).toHaveLength(0);
  });

  it('does not match an OS-source patch whose category is not literally "third_party_app"', async () => {
    mockPendingAndApprovals(
      [pendingRow({ patchId: 'aaaaaaaa-0000-0000-0000-000000000011', source: 'microsoft', category: 'application' })],
      []
    );

    const approved = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, ringWithThirdPartyRule);

    expect(approved).toHaveLength(0);
  });

  it('an exact category rule governs; an unrelated third_party_app rule never applies to it (no virtual fallback)', async () => {
    mockPendingAndApprovals(
      [pendingRow({ patchId: 'aaaaaaaa-0000-0000-0000-000000000012', source: 'third_party', category: 'homebrew', severity: 'low' })],
      []
    );

    const approved = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ...consentedRingWithThirdPartyRule,
      categoryRules: [
        { category: 'homebrew', autoApprove: true, severityFilter: ['critical'] },
        { category: 'third_party_app', autoApprove: true },
      ],
    });

    expect(approved).toHaveLength(0);
  });

  it('applies the severity filter on a literal "third_party_app" category rule', async () => {
    mockPendingAndApprovals(
      [pendingRow({ patchId: 'aaaaaaaa-0000-0000-0000-000000000013', source: 'third_party', category: 'third_party_app', severity: 'low' })],
      []
    );

    const approved = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ...consentedRingWithThirdPartyRule,
      categoryRules: [{ category: 'third_party_app', autoApprove: true, severityFilter: ['critical'] }],
    });

    expect(approved).toHaveLength(0);
  });

  it('does NOT auto-approve a null-severity patch under a literal "third_party_app" category severity filter', async () => {
    // Mirrors the ring/policy fail-closed posture: a null-severity patch must
    // not slip past a non-empty category severityFilter.
    mockPendingAndApprovals(
      [pendingRow({ patchId: 'aaaaaaaa-0000-0000-0000-00000000001a', source: 'third_party', category: 'third_party_app', severity: null })],
      []
    );

    const approved = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ...consentedRingWithThirdPartyRule,
      categoryRules: [{ category: 'third_party_app', autoApprove: true, severityFilter: ['critical'] }],
    });

    expect(approved).toHaveLength(0);
  });

  it('applies the deferral window on a literal "third_party_app" category rule', async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    mockPendingAndApprovals(
      [pendingRow({ patchId: 'aaaaaaaa-0000-0000-0000-000000000014', source: 'third_party', category: 'third_party_app', releaseDate: yesterday })],
      []
    );

    const approved = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ...consentedRingWithThirdPartyRule,
      categoryRules: [{ category: 'third_party_app', autoApprove: true, deferralDaysOverride: 7 }],
    });

    expect(approved).toHaveLength(0);
  });

  it('fails closed when a category deferral is configured and releaseDate is missing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mockPendingAndApprovals(
        [pendingRow({ patchId: 'aaaaaaaa-0000-0000-0000-000000000019', source: 'third_party', category: 'third_party_app', releaseDate: null })],
        []
      );

      const approved = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
        ...consentedRingWithThirdPartyRule,
        categoryRules: [{ category: 'third_party_app', autoApprove: true, deferralDaysOverride: 7 }],
      });

      expect(approved).toHaveLength(0);
      const warning = String(warnSpy.mock.calls[0]?.[0] ?? '');
      expect(warning).toContain('category deferral');
      expect(warning).toContain('cannot prove its age');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not match the third_party_app rule when the patch category is null (no virtual source-fallback)', async () => {
    mockPendingAndApprovals(
      [pendingRow({ patchId: 'aaaaaaaa-0000-0000-0000-000000000015', source: 'third_party', category: null })],
      []
    );

    const approved = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, ringWithThirdPartyRule);

    expect(approved).toHaveLength(0);
  });

  it('a matching autoApprove:false category rule blocks approval regardless of an unrelated third_party_app rule', async () => {
    mockPendingAndApprovals(
      [pendingRow({ patchId: 'aaaaaaaa-0000-0000-0000-000000000016', source: 'third_party', category: 'homebrew' })],
      []
    );

    const approved = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ...consentedRingWithThirdPartyRule,
      categoryRules: [
        { category: 'homebrew', autoApprove: false },
        { category: 'third_party_app', autoApprove: true },
      ],
    });

    expect(approved).toHaveLength(0);
  });

  it('source filtering still applies; a same-source patch with a different category no longer matches a third_party_app rule', async () => {
    mockPendingAndApprovals(
      [
        pendingRow({ patchId: 'aaaaaaaa-0000-0000-0000-000000000017', source: 'microsoft', category: 'security' }),
        pendingRow({ patchId: 'aaaaaaaa-0000-0000-0000-000000000018', source: 'third_party', category: 'homebrew' }),
      ],
      []
    );

    const approved = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ...ringWithThirdPartyRule,
      sources: ['third_party'],
    });

    expect(approved).toEqual([]);
  });
});

describe('category rules — repaired semantics (#spec 2026-08-04)', () => {
  beforeEach(() => {
    vi.mocked(db.select).mockReset();
  });

  it('enforces autoApproveSeverities written by the route/UI (was silently ignored)', async () => {
    mockPendingAndApprovals(
      [pendingRow({ patchId: P1, category: 'security', severity: 'moderate' })],
      []
    );

    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: RING_ID,
      categoryRules: [{ category: 'security', autoApprove: true, autoApproveSeverities: ['critical'] }],
      autoApprove: {},
      deferralDays: 0,
    });

    expect(result).toEqual([]);
  });

  it('prefers autoApproveSeverities over severityFilter when both are present', async () => {
    // Canonical field wins; the legacy alias must not resurrect a wider list.
    mockPendingAndApprovals(
      [pendingRow({ patchId: P1, source: 'microsoft', category: 'security', severity: 'low' })],
      []
    );
    const refused = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: RING_ID,
      categoryRules: [{ category: 'security', autoApprove: true, autoApproveSeverities: ['critical'], severityFilter: ['low'] }],
      autoApprove: {},
      deferralDays: 0,
    });
    expect(refused).toEqual([]);

    mockPendingAndApprovals(
      [pendingRow({ patchId: P1, source: 'microsoft', category: 'security', severity: 'critical' })],
      []
    );
    const approved = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: RING_ID,
      categoryRules: [{ category: 'security', autoApprove: true, autoApproveSeverities: ['critical'], severityFilter: ['low'] }],
      autoApprove: {},
      deferralDays: 0,
    });
    expect(approved).toHaveLength(1);
    expect(approved[0]?.approvalReason).toBe('category_rule');
  });

  it('still honors legacy stored severityFilter as a read alias', async () => {
    mockPendingAndApprovals(
      [pendingRow({ patchId: P1, category: 'security', severity: 'critical' })],
      []
    );

    const approved = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: RING_ID,
      categoryRules: [{ category: 'security', autoApprove: true, severityFilter: ['critical'] }],
      autoApprove: {},
      deferralDays: 0,
    });

    expect(approved.map((r) => r.patchId)).toEqual([P1]);
    expect(approved[0]?.approvalReason).toBe('category_rule');

    mockPendingAndApprovals(
      [pendingRow({ patchId: P1, category: 'security', severity: 'low' })],
      []
    );

    const notApproved = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: RING_ID,
      categoryRules: [{ category: 'security', autoApprove: true, severityFilter: ['critical'] }],
      autoApprove: {},
      deferralDays: 0,
    });

    expect(notApproved).toEqual([]);
  });

  it('treats a matching autoApprove:false rule as terminal — no fall-through to ring auto-approve', async () => {
    mockPendingAndApprovals(
      [pendingRow({ patchId: P1, category: 'security', severity: 'critical' })],
      []
    );

    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: RING_ID,
      categoryRules: [{ category: 'security', autoApprove: false }],
      autoApprove: { enabled: true, severities: ['critical'] },
      deferralDays: 0,
    });

    expect(result).toEqual([]);
  });

  it('no longer matches third-party patches to a third_party_app rule', async () => {
    mockPendingAndApprovals(
      [pendingRow({ patchId: P1, source: 'third_party', category: 'application', severity: 'critical' })],
      []
    );

    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: RING_ID,
      categoryRules: [{ category: 'third_party_app', autoApprove: true }],
      autoApprove: { enabled: false, severities: [] },
      deferralDays: 0,
      sources: ['os', 'third_party'],
    });

    expect(result).toEqual([]);
  });
});

describe('category rule autoApproveUnrated (#3758)', () => {
  beforeEach(() => {
    vi.mocked(db.select).mockReset();
  });

  it('auto-approves a null-severity patch matching a category rule with autoApproveUnrated: true', async () => {
    mockPendingAndApprovals(
      [pendingRow({ patchId: P1, category: 'security', severity: null })],
      []
    );

    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: RING_ID,
      categoryRules: [
        { category: 'security', autoApprove: true, autoApproveSeverities: ['critical'], autoApproveUnrated: true },
      ],
      autoApprove: { enabled: false, severities: [], deferralDays: 0 },
      deferralDays: 0,
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.approvalReason).toBe('category_rule');
  });

  it('holds a null-severity patch matching a category rule without autoApproveUnrated', async () => {
    mockPendingAndApprovals(
      [pendingRow({ patchId: P1, category: 'security', severity: null })],
      []
    );

    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: RING_ID,
      categoryRules: [
        { category: 'security', autoApprove: true, autoApproveSeverities: ['critical'] },
      ],
      autoApprove: { enabled: false, severities: [], deferralDays: 0 },
      deferralDays: 0,
    });

    expect(result).toEqual([]);
  });
});

// ---- Ring-level auto-approve (#1317): enabled + severities + deferral ----
describe('ring-level auto-approve', () => {
  beforeEach(() => {
    vi.mocked(db.select).mockReset();
  });

  it('approves a matching-severity patch with reason ring_auto_approve', async () => {
    mockPendingAndApprovals([pendingRow({ patchId: P1, severity: 'critical' })], []);

    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: RING_ID,
      categoryRules: [],
      autoApprove: { enabled: true, severities: ['critical', 'important'], deferralDays: 0 },
      deferralDays: 0,
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.approvalReason).toBe('ring_auto_approve');
  });

  it('does not approve a severity outside the ring list', async () => {
    mockPendingAndApprovals([pendingRow({ patchId: P1, severity: 'low' })], []);

    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: RING_ID,
      categoryRules: [],
      autoApprove: { enabled: true, severities: ['critical', 'important'], deferralDays: 0 },
      deferralDays: 0,
    });

    expect(result).toEqual([]);
  });

  it('holds a matching patch inside the ring deferral window', async () => {
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    mockPendingAndApprovals([pendingRow({ patchId: P1, severity: 'critical', releaseDate: yesterday })], []);

    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: RING_ID,
      categoryRules: [],
      autoApprove: { enabled: true, severities: ['critical'], deferralDays: 7 },
      deferralDays: 0,
    });

    expect(result).toEqual([]);
  });

  it('approves once the ring deferral window has elapsed', async () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
    mockPendingAndApprovals([pendingRow({ patchId: P1, severity: 'critical', releaseDate: tenDaysAgo })], []);

    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: RING_ID,
      categoryRules: [],
      autoApprove: { enabled: true, severities: ['critical'], deferralDays: 7 },
      deferralDays: 0,
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.approvalReason).toBe('ring_auto_approve');
  });

  it('fails closed (holds + warns) when ring deferral > 0 and releaseDate is missing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mockPendingAndApprovals([pendingRow({ patchId: P1, severity: 'critical', releaseDate: null })], []);

      const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
        ringId: RING_ID,
        categoryRules: [],
        autoApprove: { enabled: true, severities: ['critical'], deferralDays: 7 },
        deferralDays: 0,
      });

      expect(result).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('cannot prove its age'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('legacy boolean true shorthand approves NOTHING (fail-closed, not approve-all)', async () => {
    // A legacy `autoApprove: true` row carries no severity set. The read
    // boundary must NOT treat that as "approve every pending patch" — that was
    // the auto-approve-all fail-open. With no explicit severities, it approves
    // nothing, mirroring the write-side ringAutoApproveSchema refinement.
    mockPendingAndApprovals(
      [
        pendingRow({ patchId: P1, devicePatchId: 'dp-1', severity: 'low' }),
        pendingRow({ patchId: P2, devicePatchId: 'dp-2', severity: 'critical' }),
      ],
      []
    );

    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: RING_ID,
      categoryRules: [],
      autoApprove: true,
      deferralDays: 0,
    });

    expect(result).toEqual([]);
  });

  it('enabled with an EMPTY severity set approves NOTHING (fail-closed at read boundary)', async () => {
    // Reproduces the auto-approve-all hole: a row written outside the route Zod
    // schema (e.g. the manage_update_rings AI tool) can persist enabled with no
    // severities. The reader must approve nothing, never every pending patch.
    mockPendingAndApprovals(
      [
        pendingRow({ patchId: P1, devicePatchId: 'dp-1', severity: 'critical' }),
        pendingRow({ patchId: P2, devicePatchId: 'dp-2', severity: 'low' }),
      ],
      []
    );

    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: RING_ID,
      categoryRules: [],
      autoApprove: { enabled: true, severities: [], deferralDays: 0 },
      deferralDays: 0,
    });

    expect(result).toEqual([]);
  });

  it('does NOT auto-approve a null-severity patch under a restricted severity list', async () => {
    // Asymmetry bug: a patch with severity:null short-circuited the severity
    // filter and fell through to ring_auto_approve even though the ring
    // restricted to ['critical']. It must be held, matching the policy path.
    mockPendingAndApprovals(
      [
        pendingRow({ patchId: P1, devicePatchId: 'dp-1', severity: null }),
        pendingRow({ patchId: P2, devicePatchId: 'dp-2', severity: 'critical' }),
      ],
      []
    );

    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: RING_ID,
      categoryRules: [],
      autoApprove: { enabled: true, severities: ['critical'], deferralDays: 0 },
      deferralDays: 0,
    });

    // Only the critical patch auto-approves; the null-severity one is held.
    expect(result.map((r) => r.patchId)).toEqual([P2]);
    expect(result[0]?.approvalReason).toBe('ring_auto_approve');
  });

  it('auto-approves a null-severity patch when autoApproveUnrated is true', async () => {
    mockPendingAndApprovals([pendingRow({ patchId: P1, severity: null })], []);

    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: RING_ID,
      categoryRules: [],
      autoApprove: { enabled: true, severities: ['critical'], deferralDays: 0, autoApproveUnrated: true },
      deferralDays: 0,
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.approvalReason).toBe('ring_auto_approve');
  });

  it('auto-approves a severity:"unknown" patch when autoApproveUnrated is true (same as null)', async () => {
    mockPendingAndApprovals([pendingRow({ patchId: P1, severity: 'unknown' })], []);

    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: RING_ID,
      categoryRules: [],
      autoApprove: { enabled: true, severities: ['critical'], deferralDays: 0, autoApproveUnrated: true },
      deferralDays: 0,
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.approvalReason).toBe('ring_auto_approve');
  });

  it('still holds a null-severity patch when autoApproveUnrated is false (default)', async () => {
    mockPendingAndApprovals([pendingRow({ patchId: P1, severity: null })], []);

    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: RING_ID,
      categoryRules: [],
      autoApprove: { enabled: true, severities: ['critical'], deferralDays: 0 },
      deferralDays: 0,
    });

    expect(result).toEqual([]);
  });

  it('disabled ring auto-approve approves nothing without a manual approval', async () => {
    mockPendingAndApprovals([pendingRow({ patchId: P1, severity: 'critical' })], []);

    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: RING_ID,
      categoryRules: [],
      autoApprove: { enabled: false, severities: [], deferralDays: 0 },
      deferralDays: 0,
    });

    expect(result).toEqual([]);
  });
});

// ---- Partner-scoped approvals + cross-partner ring guard ----
describe('partner-scoped approval evaluation', () => {
  beforeEach(() => {
    vi.mocked(db.select).mockReset();
  });

  it('returns [] when org has no partner', async () => {
    // Simulate org lookup returning no row
    const orgChain: any = {
      from: vi.fn(() => orgChain),
      where: vi.fn(() => orgChain),
      limit: vi.fn(() => Promise.resolve([])), // no org row
    };
    vi.mocked(db.select).mockReturnValueOnce(orgChain);

    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: null,
      categoryRules: [],
      autoApprove: {},
      deferralDays: 0,
    });

    expect(result).toEqual([]);
  });

  it('ring-specific manual approval wins over partner-wide for same patchId', async () => {
    // Both a ring-specific and a partner-wide (null ringId) row exist for P1.
    // The ring-specific row is still returned from the partner query; the
    // manualApprovalSet accepts both (ring-specific OR null ringId). This
    // confirms ring-specific approvals are correctly included when partner-scoped.
    mockPendingAndApprovals(
      [pendingRow({ patchId: P1, severity: 'critical' })],
      [
        { patchId: P1, status: 'approved', ringId: RING_ID },  // ring-specific
        { patchId: P1, status: 'approved', ringId: null },     // partner-wide blanket
      ],
    );

    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: RING_ID,
      categoryRules: [],
      autoApprove: { enabled: false },
      deferralDays: 0,
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.approvalReason).toBe('manual');
  });

  it('partner-wide (ringId NULL) manual approval applies under any ring', async () => {
    // A partner-wide blanket (ring_id NULL) approval should approve the patch
    // for this device regardless of which ring the device is in.
    mockPendingAndApprovals(
      [pendingRow({ patchId: P1, severity: 'critical' })],
      [{ patchId: P1, status: 'approved', ringId: null }],  // ring_id NULL = partner-wide
    );

    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: RING_ID,
      categoryRules: [],
      autoApprove: { enabled: false },
      deferralDays: 0,
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.approvalReason).toBe('manual');
  });

  it('ring auto-approve by severity works with partner-scoped query', async () => {
    mockPendingAndApprovals(
      [pendingRow({ patchId: P1, severity: 'critical' })],
      [],  // no manual approvals
    );

    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: RING_ID,
      categoryRules: [],
      autoApprove: { enabled: true, severities: ['critical'], deferralDays: 0 },
      deferralDays: 0,
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.approvalReason).toBe('ring_auto_approve');
  });

  it('cross-partner ring is ignored (treated as no ring)', async () => {
    // ringPartnerId differs from the device-org's partner → ring is dropped.
    // Without a ring and no manual approvals, nothing is approved.
    mockPendingAndApprovals(
      [pendingRow({ patchId: P1, severity: 'critical' })],
      [],  // no manual approvals
    );

    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: RING_ID,
      ringPartnerId: OTHER_PARTNER_ID,  // different partner from PARTNER_ID
      categoryRules: [],
      // ring auto-approve that would have approved if ring wasn't dropped
      autoApprove: { enabled: true, severities: ['critical'], deferralDays: 0 },
      deferralDays: 0,
    });

    // Ring was dropped → ring auto-approve never runs → nothing approved
    expect(result).toEqual([]);
  });

  it('same-partner ring is NOT dropped (guard is partner-equality check)', async () => {
    mockPendingAndApprovals(
      [pendingRow({ patchId: P1, severity: 'critical' })],
      [],
    );

    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: RING_ID,
      ringPartnerId: PARTNER_ID,  // same as device-org's partner
      categoryRules: [],
      autoApprove: { enabled: true, severities: ['critical'], deferralDays: 0 },
      deferralDays: 0,
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.approvalReason).toBe('ring_auto_approve');
  });

  it('ring guard is skipped when ringPartnerId is absent (legacy/unset configs)', async () => {
    // When ringPartnerId is not set on the config, the guard does not drop the
    // ring (legacy callers that have not yet been updated).
    mockPendingAndApprovals(
      [pendingRow({ patchId: P1, severity: 'critical' })],
      [],
    );

    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: RING_ID,
      // ringPartnerId intentionally absent
      categoryRules: [],
      autoApprove: { enabled: true, severities: ['critical'], deferralDays: 0 },
      deferralDays: 0,
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.approvalReason).toBe('ring_auto_approve');
  });
});

// ---- Ring category include/exclude filter (#2117) ----
describe('isCategoryAllowed', () => {
  it('allows everything when both lists are empty/absent', () => {
    expect(isCategoryAllowed('security', [], [])).toBe(true);
    expect(isCategoryAllowed('security', undefined, undefined)).toBe(true);
    expect(isCategoryAllowed(null, [], [])).toBe(true);
  });

  it('drops a patch whose category is in excludeCategories', () => {
    expect(isCategoryAllowed('driver', [], ['driver'])).toBe(false);
    expect(isCategoryAllowed('security', [], ['driver'])).toBe(true);
  });

  it('exclude matching is case-insensitive and canonicalizes definition/definitions', () => {
    expect(isCategoryAllowed('DRIVER', [], ['driver'])).toBe(false);
    // ring stored singular 'definition'; agent emits plural 'definitions'
    expect(isCategoryAllowed('definitions', [], ['definition'])).toBe(false);
    expect(isCategoryAllowed('definition', [], ['definitions'])).toBe(false);
  });

  it('never excludes a null-category patch (cannot be in the set)', () => {
    expect(isCategoryAllowed(null, [], ['driver'])).toBe(true);
  });

  it('with a non-empty allowlist, keeps only in-list categories', () => {
    expect(isCategoryAllowed('security', ['security'], [])).toBe(true);
    expect(isCategoryAllowed('feature', ['security'], [])).toBe(false);
  });

  it('an active allowlist drops a null-category patch (fail-closed narrowing)', () => {
    expect(isCategoryAllowed(null, ['security'], [])).toBe(false);
  });

  it('exclude wins over include when a category is in both', () => {
    expect(isCategoryAllowed('security', ['security'], ['security'])).toBe(false);
  });
});

describe('ring category include/exclude filtering in resolveApprovedPatchesForDevice', () => {
  beforeEach(() => {
    vi.mocked(db.select).mockReset();
  });

  it('drops patches in excludeCategories from the approved set', async () => {
    mockPendingAndApprovals(
      [
        pendingRow({ patchId: P1, devicePatchId: 'dp-1', category: 'security', severity: 'critical' }),
        pendingRow({ patchId: P2, devicePatchId: 'dp-2', category: 'driver', severity: 'critical' }),
      ],
      []
    );

    const approved = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ...baseRing,
      excludeCategories: ['driver'],
    });

    expect(approved.map((p) => p.patchId)).toEqual([P1]);
  });

  it('exclude filter overrides an explicit manual approval (never installs excluded)', async () => {
    mockPendingAndApprovals(
      [pendingRow({ patchId: P1, category: 'driver', severity: 'low' })],
      [{ patchId: P1, status: 'approved', ringId: null }]
    );

    const approved = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ...baseRing,
      excludeCategories: ['driver'],
    });

    expect(approved).toEqual([]);
  });

  it('canonicalizes so a singular "definition" exclusion drops the agent\'s "definitions" patch', async () => {
    mockPendingAndApprovals(
      [pendingRow({ patchId: P1, category: 'definitions', severity: 'critical' })],
      []
    );

    const approved = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ...baseRing,
      excludeCategories: ['definition'],
    });

    expect(approved).toEqual([]);
  });

  it('with a non-empty allowlist keeps only in-list categories', async () => {
    mockPendingAndApprovals(
      [
        pendingRow({ patchId: P1, devicePatchId: 'dp-1', category: 'security', severity: 'critical' }),
        pendingRow({ patchId: P2, devicePatchId: 'dp-2', category: 'feature', severity: 'critical' }),
      ],
      []
    );

    const approved = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ...baseRing,
      categories: ['security'],
    });

    expect(approved.map((p) => p.patchId)).toEqual([P1]);
  });

  it('allowlist overrides an explicit manual approval for an out-of-list category', async () => {
    mockPendingAndApprovals(
      [pendingRow({ patchId: P1, category: 'feature', severity: 'low' })],
      [{ patchId: P1, status: 'approved', ringId: null }]
    );

    const approved = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ...baseRing,
      categories: ['security'],
    });

    expect(approved).toEqual([]);
  });

  it('an active allowlist drops a null-category patch (fail-closed early return)', async () => {
    mockPendingAndApprovals(
      [pendingRow({ patchId: P1, category: null, severity: 'critical' })],
      [{ patchId: P1, status: 'approved', ringId: null }]
    );

    const approved = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ...baseRing,
      categories: ['security'],
    });

    expect(approved).toEqual([]);
  });

  it('applies no category filtering when both lists are absent (legacy jobs)', async () => {
    mockPendingAndApprovals(
      [
        pendingRow({ patchId: P1, devicePatchId: 'dp-1', category: 'security', severity: 'critical' }),
        pendingRow({ patchId: P2, devicePatchId: 'dp-2', category: 'driver', severity: 'critical' }),
      ],
      []
    );

    const approved = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, baseRing);

    expect(approved).toHaveLength(2);
  });
});

// ---- Third-party severity exemption for ring auto-approve (#2218) ----
describe('third-party severity exemption for ring auto-approve (#2218)', () => {
  beforeEach(() => {
    vi.mocked(db.select).mockReset();
  });

  /** Winget-shaped patch: no vendor severity, no release date. */
  const wingetRow = (overrides: Partial<PendingRow> = {}) =>
    pendingRow({
      patchId: P1,
      source: 'third_party',
      category: 'application',
      severity: 'unknown',
      releaseDate: null,
      packageId: 'Mozilla.Firefox',
      version: '121.0',
      ...overrides,
    });

  const thirdPartyRing: RingConfig = {
    ringId: RING_ID,
    categoryRules: [],
    autoApprove: { enabled: true, severities: ['critical', 'important'], deferralDays: 0 },
    deferralDays: 0,
    sources: ['os', 'third_party'],
  };

  it('auto-approves a winget-shaped patch (severity=unknown, releaseDate=null) on a third_party-enabled ring', async () => {
    mockPendingAndApprovals([wingetRow()], []);

    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, thirdPartyRing);

    expect(result.map((r) => r.patchId)).toEqual([P1]);
    expect(result[0]?.approvalReason).toBe('ring_auto_approve');
  });

  it('also exempts a custom-source patch (third_party bucket)', async () => {
    mockPendingAndApprovals([wingetRow({ source: 'custom' })], []);

    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, thirdPartyRing);

    expect(result).toHaveLength(1);
    expect(result[0]?.approvalReason).toBe('ring_auto_approve');
  });

  it('does NOT approve the same patch when sources is ["os"] (source gate still applies)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mockPendingAndApprovals([wingetRow()], []);

      const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
        ...thirdPartyRing,
        sources: ['os'],
      });

      expect(result).toEqual([]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does NOT exempt third-party severity when sources is absent (legacy: no explicit third_party opt-in)', async () => {
    mockPendingAndApprovals([wingetRow()], []);

    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ...thirdPartyRing,
      sources: undefined,
    });

    expect(result).toEqual([]);
  });

  it('does NOT exempt severity when sources is ["custom"] without an explicit "third_party" selection', async () => {
    // A custom-source patch passes the source gate on sources:['custom']
    // (buildAllowedPatchSources admits explicit 'custom'), but the exemption
    // reads the RAW policy array for the literal 'third_party', which is
    // absent here — so the unknown-severity custom patch stays held. This pins
    // the raw-array vs expanded-bucket lockstep documented in the source.
    mockPendingAndApprovals([wingetRow({ source: 'custom' })], []);

    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ...thirdPartyRing,
      sources: ['custom'],
    });

    expect(result).toEqual([]);
  });

  it('OS patch severity gating is unchanged on a third_party-enabled ring', async () => {
    mockPendingAndApprovals(
      [
        pendingRow({ patchId: P1, devicePatchId: 'dp-1', source: 'microsoft', severity: 'unknown' }),
        pendingRow({ patchId: P2, devicePatchId: 'dp-2', source: 'microsoft', severity: 'critical' }),
      ],
      []
    );

    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, thirdPartyRing);

    // Only the in-list OS severity approves; 'unknown' stays held.
    expect(result.map((r) => r.patchId)).toEqual([P2]);
    expect(result[0]?.approvalReason).toBe('ring_auto_approve');
  });

  it('empty-severities kill-switch still approves nothing, even for exempt third-party patches', async () => {
    mockPendingAndApprovals([wingetRow()], []);

    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ...thirdPartyRing,
      autoApprove: { enabled: true, severities: [], deferralDays: 0 },
    });

    expect(result).toEqual([]);
  });

  it('app block rules still apply to exempt third-party patches', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mockPendingAndApprovals([wingetRow()], []);

      const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
        ...thirdPartyRing,
        apps: [{ source: 'third_party', packageId: 'Mozilla.Firefox', action: 'block' }],
      });

      expect(result).toEqual([]);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ---- Deferral fallback to first-seen for third-party patches (#2218) ----
describe('deferral first-seen fallback for third-party patches (#2218)', () => {
  beforeEach(() => {
    vi.mocked(db.select).mockReset();
  });

  const deferredRing: RingConfig = {
    ringId: RING_ID,
    categoryRules: [],
    autoApprove: { enabled: true, severities: ['critical'], deferralDays: 7 },
    deferralDays: 0,
    sources: ['third_party'],
  };

  it('holds a third-party patch first seen inside the deferral window', async () => {
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000);
    mockPendingAndApprovals(
      [pendingRow({ patchId: P1, source: 'third_party', severity: 'unknown', releaseDate: null, firstSeenAt: yesterday })],
      []
    );

    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, deferredRing);

    expect(result).toEqual([]);
  });

  it('approves a third-party patch first seen past the deferral window', async () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 3600 * 1000);
    mockPendingAndApprovals(
      [pendingRow({ patchId: P1, source: 'third_party', severity: 'unknown', releaseDate: null, firstSeenAt: tenDaysAgo })],
      []
    );

    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, deferredRing);

    expect(result).toHaveLength(1);
    expect(result[0]?.approvalReason).toBe('ring_auto_approve');
  });

  it('prefers releaseDate over first-seen when releaseDate is past the window', async () => {
    // Released 10 days ago but only first seen yesterday: releaseDate anchors
    // the window, so the patch is past the 7-day hold.
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000);
    mockPendingAndApprovals(
      [pendingRow({ patchId: P1, source: 'third_party', severity: 'unknown', releaseDate: tenDaysAgo, firstSeenAt: yesterday })],
      []
    );

    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, deferredRing);

    expect(result).toHaveLength(1);
    expect(result[0]?.approvalReason).toBe('ring_auto_approve');
  });

  it('prefers releaseDate over first-seen when releaseDate is inside the window (held)', async () => {
    // Complementary direction: released yesterday (inside the 7-day hold) but
    // first seen 10 days ago. releaseDate must win, so the patch is HELD — a
    // bug that anchored on the older/more-permissive first-seen would approve.
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 3600 * 1000);
    mockPendingAndApprovals(
      [pendingRow({ patchId: P1, source: 'third_party', severity: 'unknown', releaseDate: yesterday, firstSeenAt: tenDaysAgo })],
      []
    );

    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, deferredRing);

    expect(result).toEqual([]);
  });

  it('fails closed for a third-party patch with an unparseable releaseDate (does NOT fall through to first-seen)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // A present-but-garbage releaseDate is a truthy Invalid Date, so the
      // first-seen fallback is skipped; the Number.isNaN guard then holds it.
      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 3600 * 1000);
      mockPendingAndApprovals(
        [pendingRow({ patchId: P1, source: 'third_party', severity: 'unknown', releaseDate: 'not-a-date', firstSeenAt: tenDaysAgo })],
        []
      );

      const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, deferredRing);

      expect(result).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('its releaseDate value is unparseable'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('still fails closed for a third-party patch with neither releaseDate nor firstSeenAt', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mockPendingAndApprovals(
        [pendingRow({ patchId: P1, source: 'third_party', severity: 'unknown', releaseDate: null, firstSeenAt: null })],
        []
      );

      const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, deferredRing);

      expect(result).toEqual([]);
      // Assert the specific reason so the anchor-differentiation feature can't
      // silently regress to the generic message.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('it has no releaseDate and no first-seen fallback timestamp')
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does NOT extend the first-seen fallback to OS patches (fail-closed unchanged)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 3600 * 1000);
      mockPendingAndApprovals(
        [pendingRow({ patchId: P1, source: 'microsoft', severity: 'critical', releaseDate: null, firstSeenAt: tenDaysAgo })],
        []
      );

      const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
        ...deferredRing,
        sources: ['os'],
      });

      expect(result).toEqual([]);
      // OS path never mentions a first-seen fallback: bare "it has no releaseDate".
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('but it has no releaseDate, so it cannot prove its age')
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('applies the first-seen fallback on a literal "third_party_app" category deferral too', async () => {
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000);
    mockPendingAndApprovals(
      [pendingRow({ patchId: P1, source: 'third_party', severity: 'unknown', releaseDate: null, firstSeenAt: yesterday, category: 'third_party_app' })],
      []
    );

    const held = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: RING_ID,
      categoryRules: [{ category: 'third_party_app', autoApprove: true, deferralDaysOverride: 7 }],
      autoApprove: { enabled: true, severities: [], thirdPartyApps: true },
      deferralDays: 0,
      sources: ['third_party'],
    });
    expect(held).toEqual([]);

    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 3600 * 1000);
    mockPendingAndApprovals(
      [pendingRow({ patchId: P1, source: 'third_party', severity: 'unknown', releaseDate: null, firstSeenAt: tenDaysAgo, category: 'third_party_app' })],
      []
    );

    const approved = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: RING_ID,
      categoryRules: [{ category: 'third_party_app', autoApprove: true, deferralDaysOverride: 7 }],
      autoApprove: { enabled: true, severities: [], thirdPartyApps: true },
      deferralDays: 0,
      sources: ['third_party'],
    });
    expect(approved).toHaveLength(1);
    expect(approved[0]?.approvalReason).toBe('category_rule');
  });
});

// ---- Ring auto-approve: third-party dual consent (#spec 2026-08-04) ----
describe('ring auto-approve — third-party dual consent (#spec 2026-08-04)', () => {
  beforeEach(() => {
    vi.mocked(db.select).mockReset();
  });

  it('approves a third-party patch only with BOTH policy sources third_party AND ring thirdPartyApps', async () => {
    mockPendingAndApprovals(
      [pendingRow({ patchId: P1, source: 'third_party', severity: 'unknown', releaseDate: null })],
      []
    );

    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: RING_ID,
      categoryRules: [],
      autoApprove: { enabled: true, severities: [], thirdPartyApps: true, deferralDays: 0 },
      deferralDays: 0,
      sources: ['os', 'third_party'],
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.approvalReason).toBe('ring_auto_approve');
  });

  it('does not approve third-party when the ring toggle is off, even with policy consent', async () => {
    mockPendingAndApprovals(
      [pendingRow({ patchId: P1, source: 'third_party', severity: 'unknown', releaseDate: null })],
      []
    );

    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: RING_ID,
      categoryRules: [],
      autoApprove: { enabled: true, severities: ['critical'], thirdPartyApps: false, deferralDays: 0 },
      deferralDays: 0,
      sources: ['os', 'third_party'],
    });

    expect(result).toEqual([]);
  });

  it('does not approve third-party when policy sources are absent (legacy snapshot) even with the toggle on', async () => {
    mockPendingAndApprovals(
      [pendingRow({ patchId: P1, source: 'third_party', severity: 'unknown', releaseDate: null })],
      []
    );

    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: RING_ID,
      categoryRules: [],
      autoApprove: { enabled: true, severities: [], thirdPartyApps: true, deferralDays: 0 },
      deferralDays: 0,
      sources: undefined,
    });

    expect(result).toEqual([]);
  });

  it('supports a third-party-only ring: empty severities approves 3P and no OS patches', async () => {
    mockPendingAndApprovals(
      [
        pendingRow({ patchId: P1, devicePatchId: 'dp-1', source: 'third_party', severity: 'unknown', releaseDate: null }),
        pendingRow({ patchId: P2, devicePatchId: 'dp-2', source: 'microsoft', severity: 'critical' }),
      ],
      []
    );

    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: RING_ID,
      categoryRules: [],
      autoApprove: { enabled: true, severities: [], thirdPartyApps: true, deferralDays: 0 },
      deferralDays: 0,
      sources: ['os', 'third_party'],
    });

    expect(result.map((r) => r.patchId)).toEqual([P1]);
    expect(result[0]?.approvalReason).toBe('ring_auto_approve');
  });

  it('treats custom-source patches as third-party for the toggle', async () => {
    mockPendingAndApprovals(
      [pendingRow({ patchId: P1, source: 'custom', severity: 'unknown', releaseDate: null })],
      []
    );

    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: RING_ID,
      categoryRules: [],
      autoApprove: { enabled: true, severities: [], thirdPartyApps: true, deferralDays: 0 },
      deferralDays: 0,
      sources: ['os', 'third_party'],
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.approvalReason).toBe('ring_auto_approve');
  });

  it('applies thirdPartyDeferralDays over deferralDays for 3P, anchored on firstSeenAt', async () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    mockPendingAndApprovals(
      [pendingRow({ patchId: P1, source: 'third_party', severity: 'unknown', releaseDate: null, firstSeenAt: threeDaysAgo })],
      []
    );

    const held = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: RING_ID,
      categoryRules: [],
      autoApprove: { enabled: true, severities: [], thirdPartyApps: true, deferralDays: 0, thirdPartyDeferralDays: 7 },
      deferralDays: 0,
      sources: ['os', 'third_party'],
    });
    expect(held).toEqual([]);

    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    mockPendingAndApprovals(
      [pendingRow({ patchId: P1, source: 'third_party', severity: 'unknown', releaseDate: null, firstSeenAt: eightDaysAgo })],
      []
    );

    const approved = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: RING_ID,
      categoryRules: [],
      autoApprove: { enabled: true, severities: [], thirdPartyApps: true, deferralDays: 0, thirdPartyDeferralDays: 7 },
      deferralDays: 0,
      sources: ['os', 'third_party'],
    });
    expect(approved).toHaveLength(1);
    expect(approved[0]?.approvalReason).toBe('ring_auto_approve');

    // null thirdPartyDeferralDays inherits deferralDays: with deferralDays:7 the
    // same 3-day-old first-seen timestamp is still held.
    const threeDaysAgo2 = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    mockPendingAndApprovals(
      [pendingRow({ patchId: P1, source: 'third_party', severity: 'unknown', releaseDate: null, firstSeenAt: threeDaysAgo2 })],
      []
    );

    const heldViaInherit = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: RING_ID,
      categoryRules: [],
      autoApprove: { enabled: true, severities: [], thirdPartyApps: true, deferralDays: 7, thirdPartyDeferralDays: null },
      deferralDays: 0,
      sources: ['os', 'third_party'],
    });
    expect(heldViaInherit).toEqual([]);
  });

  it('honors an explicit thirdPartyDeferralDays of 0 over a non-zero inherited hold', async () => {
    // Pins the ?? (not ||) semantics: 0 is an explicit "no hold" override and
    // must not fall back to deferralDays.
    mockPendingAndApprovals(
      [pendingRow({ patchId: P1, source: 'third_party', severity: 'unknown', releaseDate: null, firstSeenAt: new Date() })],
      []
    );
    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: RING_ID,
      categoryRules: [],
      autoApprove: { enabled: true, severities: [], thirdPartyApps: true, deferralDays: 7, thirdPartyDeferralDays: 0 },
      deferralDays: 0,
      sources: ['os', 'third_party'],
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.approvalReason).toBe('ring_auto_approve');
  });

  it('evaluates a mixed OS + third-party ring per-source: OS approves, 3P refused with the toggle off', async () => {
    mockPendingAndApprovals(
      [
        pendingRow({ patchId: P1, source: 'microsoft', category: 'security', severity: 'critical' }),
        pendingRow({ patchId: P2, devicePatchId: 'dp-2', source: 'third_party', severity: 'unknown', releaseDate: null }),
      ],
      []
    );
    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: RING_ID,
      categoryRules: [],
      autoApprove: { enabled: true, severities: ['critical'], thirdPartyApps: false, deferralDays: 0 },
      deferralDays: 0,
      sources: ['os', 'third_party'],
    });
    expect(result.map((r) => r.patchId)).toEqual([P1]);
    expect(result[0]?.approvalReason).toBe('ring_auto_approve');
  });

  it('a literal category allow rule cannot bypass dual consent for a third-party patch (ring toggle off)', async () => {
    mockPendingAndApprovals(
      [pendingRow({ patchId: P1, source: 'third_party', category: 'homebrew', severity: 'unknown', releaseDate: null })],
      []
    );
    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: RING_ID,
      categoryRules: [{ category: 'homebrew', autoApprove: true }],
      autoApprove: { enabled: true, severities: [], thirdPartyApps: false },
      deferralDays: 0,
      sources: ['third_party'],
    });
    expect(result).toEqual([]);
  });

  it('a literal category allow rule cannot bypass the policy-sources consent leg (legacy absent sources)', async () => {
    // Legacy job snapshots have no sources (= no upstream filtering) — exactly
    // the case the literal 'third_party' check defends. The rule must not
    // reintroduce the bypass.
    mockPendingAndApprovals(
      [pendingRow({ patchId: P1, source: 'third_party', category: 'homebrew', severity: 'unknown', releaseDate: null })],
      []
    );
    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: RING_ID,
      categoryRules: [{ category: 'homebrew', autoApprove: true }],
      autoApprove: { enabled: true, severities: [], thirdPartyApps: true },
      deferralDays: 0,
    });
    expect(result).toEqual([]);
  });

  it('a literal category allow rule approves a third-party patch once BOTH consent legs hold', async () => {
    mockPendingAndApprovals(
      [pendingRow({ patchId: P1, source: 'third_party', category: 'homebrew', severity: 'unknown', releaseDate: null })],
      []
    );
    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: RING_ID,
      categoryRules: [{ category: 'homebrew', autoApprove: true }],
      autoApprove: { enabled: true, severities: [], thirdPartyApps: true },
      deferralDays: 0,
      sources: ['third_party'],
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.approvalReason).toBe('category_rule');
  });

  it('an autoApprove:false category rule is terminal for a third-party patch even with full dual consent', async () => {
    // A per-category "needs manual approval" beats the ring-level 3P gate.
    mockPendingAndApprovals(
      [pendingRow({ patchId: P1, source: 'third_party', category: 'homebrew', severity: 'unknown', releaseDate: null })],
      []
    );
    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: RING_ID,
      categoryRules: [{ category: 'homebrew', autoApprove: false }],
      autoApprove: { enabled: true, severities: [], thirdPartyApps: true },
      deferralDays: 0,
      sources: ['third_party'],
    });
    expect(result).toEqual([]);
  });
});

describe('parseRingAutoApprove — thirdPartyApps compatibility (#spec 2026-08-04)', () => {
  it('derives thirdPartyApps=true for a legacy enabled row with recognized severities', () => {
    const cfg = parseRingAutoApprove({ enabled: true, severities: ['critical'], deferralDays: 3 });
    expect(cfg).toEqual({ enabled: true, severities: ['critical'], deferralDays: 3, thirdPartyApps: true, thirdPartyDeferralDays: null, autoApproveUnrated: false });
  });

  it('derives thirdPartyApps=false for legacy enabled rows with no recognized severities', () => {
    expect(parseRingAutoApprove({ enabled: true, severities: [] }).thirdPartyApps).toBe(false);
    expect(parseRingAutoApprove({ enabled: true, severities: ['bogus'] }).thirdPartyApps).toBe(false);
    expect(parseRingAutoApprove(true).thirdPartyApps).toBe(false);
  });

  it('honors an explicit thirdPartyApps boolean and treats malformed as false', () => {
    expect(parseRingAutoApprove({ enabled: true, severities: [], thirdPartyApps: true }).thirdPartyApps).toBe(true);
    expect(parseRingAutoApprove({ enabled: true, severities: ['critical'], thirdPartyApps: false }).thirdPartyApps).toBe(false);
    expect(parseRingAutoApprove({ enabled: true, severities: ['critical'], thirdPartyApps: 'yes' }).thirdPartyApps).toBe(false);
  });

  it('drops unrecognized severity strings', () => {
    expect(parseRingAutoApprove({ enabled: true, severities: ['critical', 'bogus', 7] }).severities).toEqual(['critical']);
  });

  it('disables the row on a present-but-invalid deferralDays instead of coercing to 0', () => {
    expect(parseRingAutoApprove({ enabled: true, severities: ['critical'], deferralDays: 'soon' }).enabled).toBe(false);
    expect(parseRingAutoApprove({ enabled: true, severities: ['critical'], deferralDays: -1 }).enabled).toBe(false);
    expect(parseRingAutoApprove({ enabled: true, severities: ['critical'], deferralDays: 1.5 }).enabled).toBe(false);
    // absent stays fine
    expect(parseRingAutoApprove({ enabled: true, severities: ['critical'] })).toMatchObject({ enabled: true, deferralDays: 0 });
  });

  it('parses thirdPartyDeferralDays: valid int kept, absent/null → inherit (null)', () => {
    expect(parseRingAutoApprove({ enabled: true, severities: [], thirdPartyApps: true, thirdPartyDeferralDays: 14 }).thirdPartyDeferralDays).toBe(14);
    expect(parseRingAutoApprove({ enabled: true, severities: [], thirdPartyApps: true, thirdPartyDeferralDays: null }).thirdPartyDeferralDays).toBeNull();
    expect(parseRingAutoApprove({ enabled: true, severities: [], thirdPartyApps: true }).thirdPartyDeferralDays).toBeNull();
  });

  it('disables the row on a present-but-invalid thirdPartyDeferralDays instead of coercing to inherit', () => {
    // Coercing to null would inherit deferralDays (often 0 = approve
    // immediately) — the fail-open direction the sibling deferralDays field
    // was already hardened against.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(parseRingAutoApprove({ enabled: true, severities: [], thirdPartyApps: true, thirdPartyDeferralDays: '30' }).enabled).toBe(false);
      expect(parseRingAutoApprove({ enabled: true, severities: [], thirdPartyApps: true, thirdPartyDeferralDays: 999 }).enabled).toBe(false);
      expect(parseRingAutoApprove({ enabled: true, severities: [], thirdPartyApps: true, thirdPartyDeferralDays: -1 }).enabled).toBe(false);
      expect(parseRingAutoApprove({ enabled: true, severities: [], thirdPartyApps: true, thirdPartyDeferralDays: 1.5 }).enabled).toBe(false);
      expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('malformed autoApprove.thirdPartyDeferralDays');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('warns (loudly, with context) when a malformed deferralDays disables the row', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(parseRingAutoApprove({ enabled: true, severities: ['critical'], deferralDays: '7' }, 'ring test-ring').enabled).toBe(false);
      const warning = String(warnSpy.mock.calls[0]?.[0] ?? '');
      expect(warning).toContain('ring test-ring');
      expect(warning).toContain('malformed autoApprove.deferralDays');
    } finally {
      warnSpy.mockRestore();
    }
  });
});
