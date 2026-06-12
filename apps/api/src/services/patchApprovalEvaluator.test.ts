import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  db: { select: vi.fn() },
}));

vi.mock('../db/schema', () => ({
  devicePatches: { id: 'id', patchId: 'patchId', deviceId: 'deviceId', status: 'status' },
  patches: {
    id: 'id', externalId: 'externalId', title: 'title', category: 'category',
    severity: 'severity', releaseDate: 'releaseDate', requiresReboot: 'requiresReboot',
    source: 'source',
  },
  patchApprovals: { patchId: 'patchId', status: 'status', ringId: 'ringId', orgId: 'orgId' },
  OUTSTANDING_DEVICE_PATCH_STATUSES: ['pending'],
}));

import { db } from '../db';
import {
  buildAllowedPatchSources,
  resolveApprovedPatchesForDevice,
  type RingConfig,
} from './patchApprovalEvaluator';

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
});

// ---- resolveApprovedPatchesForDevice with mocked Drizzle chains ----

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const DEVICE_ID = '22222222-2222-2222-2222-222222222222';
const RING_ID = '33333333-3333-3333-3333-333333333333';

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
};

function pendingRow(overrides: Partial<PendingRow>): PendingRow {
  return {
    devicePatchId: 'dp-1',
    patchId: 'aaaaaaaa-0000-0000-0000-000000000001',
    externalId: 'KB0000001',
    title: 'A patch',
    category: 'security',
    severity: 'critical',
    releaseDate: null,
    requiresReboot: false,
    source: 'microsoft',
    ...overrides,
  };
}

function mockPendingAndApprovals(pendingRows: PendingRow[], approvalRows: Array<{ patchId: string; status: string; ringId: string | null }>) {
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
    .mockReturnValueOnce(pendingChain)
    .mockReturnValueOnce(approvalChain);
}

const baseRing: RingConfig = {
  ringId: RING_ID,
  categoryRules: [],
  autoApprove: { enabled: true, severities: [] },
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
    expect(approved[0].approvalReason).toBe('category_rule');
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
});
