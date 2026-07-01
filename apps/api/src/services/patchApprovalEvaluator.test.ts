import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  db: { select: vi.fn() },
}));

vi.mock('../db/schema', () => ({
  devicePatches: { id: 'id', patchId: 'patchId', deviceId: 'deviceId', status: 'status' },
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

  it('applies no source filtering when sources is absent (legacy jobs)', async () => {
    mockPendingAndApprovals(
      [
        pendingRow({ patchId: 'aaaaaaaa-0000-0000-0000-000000000001', source: 'microsoft' }),
        pendingRow({ patchId: 'aaaaaaaa-0000-0000-0000-000000000002', source: 'third_party' }),
      ],
      []
    );

    const approved = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, baseRing);

    expect(approved).toHaveLength(2);
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
        pendingRow({ patchId: P1, devicePatchId: 'dp-1', source: 'third_party', category: 'homebrew', packageId: 'Mozilla.Firefox', version: '121.0' }),
        pendingRow({ patchId: P2, devicePatchId: 'dp-2', source: 'third_party', category: 'homebrew', packageId: 'VideoLAN.VLC', version: '3.0.20' }),
      ],
      []
    );

    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: RING_ID,
      categoryRules: [{ category: 'third_party_app', autoApprove: true }],
      autoApprove: {},
      deferralDays: 0,
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

describe('third_party_app category rule', () => {
  beforeEach(() => {
    vi.mocked(db.select).mockReset();
  });

  const ringWithThirdPartyRule: RingConfig = {
    ringId: RING_ID,
    categoryRules: [{ category: 'third_party_app', autoApprove: true }],
    autoApprove: {},
    deferralDays: 0,
  };

  it('auto-approves a third_party-source patch regardless of its category string', async () => {
    mockPendingAndApprovals(
      [pendingRow({ patchId: 'aaaaaaaa-0000-0000-0000-000000000010', source: 'third_party', category: 'homebrew-cask' })],
      []
    );

    const approved = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, ringWithThirdPartyRule);

    expect(approved).toHaveLength(1);
    expect(approved[0]?.approvalReason).toBe('category_rule');
  });

  it('does not apply the third_party_app rule to OS-source patches', async () => {
    mockPendingAndApprovals(
      [pendingRow({ patchId: 'aaaaaaaa-0000-0000-0000-000000000011', source: 'microsoft', category: 'application' })],
      []
    );

    const approved = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, ringWithThirdPartyRule);

    expect(approved).toHaveLength(0);
  });

  it('prefers an exact category rule over the third_party_app fallback', async () => {
    mockPendingAndApprovals(
      [pendingRow({ patchId: 'aaaaaaaa-0000-0000-0000-000000000012', source: 'third_party', category: 'homebrew', severity: 'low' })],
      []
    );

    const approved = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ...ringWithThirdPartyRule,
      categoryRules: [
        { category: 'homebrew', autoApprove: true, severityFilter: ['critical'] },
        { category: 'third_party_app', autoApprove: true },
      ],
    });

    expect(approved).toHaveLength(0);
  });

  it('applies the severity filter on the third_party_app rule', async () => {
    mockPendingAndApprovals(
      [pendingRow({ patchId: 'aaaaaaaa-0000-0000-0000-000000000013', source: 'third_party', category: 'homebrew', severity: 'low' })],
      []
    );

    const approved = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ...ringWithThirdPartyRule,
      categoryRules: [{ category: 'third_party_app', autoApprove: true, severityFilter: ['critical'] }],
    });

    expect(approved).toHaveLength(0);
  });

  it('does NOT auto-approve a null-severity patch under a category severity filter', async () => {
    // Mirrors the ring/policy fail-closed posture: a null-severity patch must
    // not slip past a non-empty category severityFilter.
    mockPendingAndApprovals(
      [pendingRow({ patchId: 'aaaaaaaa-0000-0000-0000-00000000001a', source: 'third_party', category: 'homebrew', severity: null })],
      []
    );

    const approved = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ...ringWithThirdPartyRule,
      categoryRules: [{ category: 'third_party_app', autoApprove: true, severityFilter: ['critical'] }],
    });

    expect(approved).toHaveLength(0);
  });

  it('applies the deferral window on the third_party_app rule', async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    mockPendingAndApprovals(
      [pendingRow({ patchId: 'aaaaaaaa-0000-0000-0000-000000000014', source: 'third_party', category: 'homebrew', releaseDate: yesterday })],
      []
    );

    const approved = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ...ringWithThirdPartyRule,
      categoryRules: [{ category: 'third_party_app', autoApprove: true, deferralDaysOverride: 7 }],
    });

    expect(approved).toHaveLength(0);
  });

  it('fails closed when a category deferral is configured and releaseDate is missing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mockPendingAndApprovals(
        [pendingRow({ patchId: 'aaaaaaaa-0000-0000-0000-000000000019', source: 'third_party', category: 'homebrew', releaseDate: null })],
        []
      );

      const approved = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
        ...ringWithThirdPartyRule,
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

  it('matches the third_party_app rule when the patch category is null', async () => {
    mockPendingAndApprovals(
      [pendingRow({ patchId: 'aaaaaaaa-0000-0000-0000-000000000015', source: 'third_party', category: null })],
      []
    );

    const approved = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, ringWithThirdPartyRule);

    expect(approved).toHaveLength(1);
    expect(approved[0]?.approvalReason).toBe('category_rule');
  });

  it('an exact category rule with autoApprove false suppresses the third_party_app fallback', async () => {
    mockPendingAndApprovals(
      [pendingRow({ patchId: 'aaaaaaaa-0000-0000-0000-000000000016', source: 'third_party', category: 'homebrew' })],
      []
    );

    const approved = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ...ringWithThirdPartyRule,
      categoryRules: [
        { category: 'homebrew', autoApprove: false },
        { category: 'third_party_app', autoApprove: true },
      ],
    });

    expect(approved).toHaveLength(0);
  });

  it('combines source filtering with the third_party_app rule (headline flow)', async () => {
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

    expect(approved.map((p) => p.patchId)).toEqual(['aaaaaaaa-0000-0000-0000-000000000018']);
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
