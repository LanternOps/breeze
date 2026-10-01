/**
 * #7625 — the device Patches tab's ring-aware approval view.
 *
 * Runs the REAL eligibility evaluator (`patchEligibility.ts` →
 * `patchApprovalEvaluator.ts`) against mocked Drizzle reads, so these tests
 * prove the tab reports what the scheduled job would decide — not a second
 * copy of the rules.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  db: { select: vi.fn() },
  getCurrentDbAccessContext: vi.fn(() => ({ scope: 'system' })),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
}));

vi.mock('../db/schema', () => ({
  devicePatches: {
    id: 'id', patchId: 'patchId', deviceId: 'deviceId', orgId: 'orgId', status: 'status',
    createdAt: 'createdAt', availableVersion: 'availableVersion',
  },
  patches: {
    id: 'id', externalId: 'externalId', title: 'title', category: 'category',
    severity: 'severity', releaseDate: 'releaseDate', requiresReboot: 'requiresReboot',
    source: 'source', packageId: 'packageId', version: 'version', supersededBy: 'supersededBy',
  },
  patchApprovals: { patchId: 'patchId', status: 'status', ringId: 'ringId', partnerId: 'partnerId' },
  patchPolicies: { id: 'id', kind: 'kind', deferralDays: 'deferralDays', partnerId: 'partnerId' },
  organizations: { id: 'id', partnerId: 'partnerId' },
  devices: { id: 'id', orgId: 'orgId' },
  OUTSTANDING_DEVICE_PATCH_STATUSES: ['pending'],
}));

vi.mock('./featureConfigResolver', () => ({ resolvePatchConfigPolicyForDevice: vi.fn() }));
vi.mock('./configPolicyPatching', () => ({ loadPolicyLocalPatchConfig: vi.fn() }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));

import { db } from '../db';
import { resolvePatchConfigPolicyForDevice } from './featureConfigResolver';
import { loadPolicyLocalPatchConfig } from './configPolicyPatching';
import { loadDevicePatchApprovalView } from './devicePatchApprovalView';

const ORG = '11111111-1111-1111-1111-111111111111';
const DEV = '22222222-2222-2222-2222-222222222222';
const RING = '33333333-3333-3333-3333-333333333333';
const PARTNER = '44444444-4444-4444-4444-444444444444';
const P1 = 'aaaaaaaa-0000-0000-0000-000000000001';
const P2 = 'aaaaaaaa-0000-0000-0000-000000000002';
const P3 = 'aaaaaaaa-0000-0000-0000-000000000003';
const P4 = 'aaaaaaaa-0000-0000-0000-000000000004';
const DAY = 86_400_000;

const row = (o: Record<string, unknown>) => ({
  devicePatchId: `dp-${String(o.patchId)}`, patchId: P1, externalId: 'KB1', title: 'A patch',
  category: 'security', severity: 'critical', releaseDate: '2020-01-01', requiresReboot: false,
  source: 'microsoft', packageId: null, version: null, firstSeenAt: null, status: 'pending',
  supersededBy: null, ...o,
});

function chain(resolveAt: 'where' | 'limit', rows: unknown[]) {
  const c: Record<string, unknown> = {};
  c.from = vi.fn(() => c);
  c.innerJoin = vi.fn(() => c);
  c.leftJoin = vi.fn(() => c);
  c.where = vi.fn(() => (resolveAt === 'where' ? Promise.resolve(rows) : c));
  c.limit = vi.fn(() => Promise.resolve(rows));
  return c;
}

/** The device's effective policy links ring "Workstations Ring" with the given ring auto-approve. */
function mockRingPolicy(ringAutoApprove: Record<string, unknown>, ringDeferralDays = 0, ringPartnerId = PARTNER) {
  vi.mocked(resolvePatchConfigPolicyForDevice).mockResolvedValue({ configPolicyId: 'cp-1' } as never);
  vi.mocked(loadPolicyLocalPatchConfig).mockResolvedValue({
    configPolicyId: 'cp-1', configPolicyName: 'Workstations', orgId: ORG, featureLinkId: 'fl-1',
    featurePolicyId: RING, sourcePolicyId: 'cp-1', inherited: false,
    // Policy-level auto-approve OFF — the Config tab's "Auto Approve: No" (#7625 symptom 2).
    settings: { sources: ['os'], autoApprove: false, autoApproveSeverities: [], autoApproveDeferralDays: 0, apps: [] },
    ring: {
      classification: 'valid_ring', valid: true, ringId: RING, ringName: 'Workstations Ring',
      categoryRules: [], categories: [], excludeCategories: [], autoApprove: ringAutoApprove,
    },
  } as never);
  // ring row (deferral + partner), then the evaluator's three reads.
  vi.mocked(db.select).mockReturnValueOnce(chain('limit', [{ deferralDays: ringDeferralDays, partnerId: ringPartnerId }]) as never);
}

function mockEvaluatorReads(pending: unknown[], approvals: unknown[] = []) {
  vi.mocked(db.select)
    .mockReturnValueOnce(chain('limit', [{ partnerId: PARTNER }]) as never)
    .mockReturnValueOnce(chain('where', pending) as never)
    .mockReturnValueOnce(chain('where', approvals) as never);
}

beforeEach(() => {
  vi.mocked(db.select).mockReset();
  vi.mocked(resolvePatchConfigPolicyForDevice).mockReset();
  vi.mocked(loadPolicyLocalPatchConfig).mockReset();
});

describe('loadDevicePatchApprovalView (#7625)', () => {
  it('reports a patch the linked ring auto-approves as auto_approved, naming the ring', async () => {
    mockRingPolicy({ enabled: true, severities: ['critical', 'important'], deferralDays: 0 });
    mockEvaluatorReads([row({ patchId: P1, severity: 'critical' })]);

    const view = await loadDevicePatchApprovalView(DEV, ORG);

    expect(view.evaluation).toEqual({ available: true, ring: { id: RING, name: 'Workstations Ring' } });
    expect(view.byPatchId.get(P1)).toEqual({ state: 'auto_approved', reason: 'ring_auto_approve', holdUntil: null });
  });

  it('reports a ring-deferred patch as deferred with the date the window ends', async () => {
    const released = new Date(Date.now() - 2 * DAY);
    mockRingPolicy({ enabled: true, severities: ['critical'], deferralDays: 7 });
    mockEvaluatorReads([row({ patchId: P1, releaseDate: released.toISOString() })]);

    const view = await loadDevicePatchApprovalView(DEV, ORG);

    expect(view.byPatchId.get(P1)).toEqual({
      state: 'deferred',
      reason: 'held_by_deferral',
      holdUntil: new Date(released.getTime() + 7 * DAY).toISOString(),
    });
  });

  it('distinguishes manual approval, needs-approval and policy exclusion on one device', async () => {
    mockRingPolicy({ enabled: true, severities: ['critical'], deferralDays: 0 });
    mockEvaluatorReads(
      [
        row({ patchId: P1, severity: 'low' }), // ring does not cover 'low', but manually approved
        row({ patchId: P2, severity: 'low' }), // ring does not cover 'low', no approval
        row({ patchId: P3, source: 'third_party', packageId: 'Mozilla.Firefox' }), // policy sources = ['os']
      ],
      [{ patchId: P1, status: 'approved', ringId: null }],
    );

    const view = await loadDevicePatchApprovalView(DEV, ORG);

    expect(view.byPatchId.get(P1)).toEqual({ state: 'approved', reason: 'manual', holdUntil: null });
    expect(view.byPatchId.get(P2)).toEqual({ state: 'needs_approval', reason: 'awaiting_manual_approval', holdUntil: null });
    expect(view.byPatchId.get(P3)).toEqual({ state: 'excluded', reason: 'blocked_by_source', holdUntil: null });
  });

  it('with no patch policy, nothing auto-approves and the ring is null', async () => {
    vi.mocked(resolvePatchConfigPolicyForDevice).mockResolvedValue(null);
    mockEvaluatorReads([row({ patchId: P4 })]);

    const view = await loadDevicePatchApprovalView(DEV, ORG);

    expect(view.evaluation).toEqual({ available: true, ring: null });
    expect(view.byPatchId.get(P4)).toEqual({ state: 'needs_approval', reason: 'no_ring_resolved', holdUntil: null });
  });

  it("names no ring and auto-approves nothing when the linked ring belongs to another partner", async () => {
    mockRingPolicy({ enabled: true, severities: ['critical'], deferralDays: 0 }, 0, '99999999-9999-9999-9999-999999999999');
    mockEvaluatorReads([row({ patchId: P1, severity: 'critical' })]);

    const view = await loadDevicePatchApprovalView(DEV, ORG);

    expect(view.evaluation.ring).toBeNull();
    expect(view.byPatchId.get(P1)).toEqual({ state: 'needs_approval', reason: 'no_ring_resolved', holdUntil: null });
  });

  it('mirrors the scheduled job on superseded patches (it does not exclude them)', async () => {
    mockRingPolicy({ enabled: true, severities: ['critical'], deferralDays: 0 });
    mockEvaluatorReads([row({ patchId: P1, supersededBy: 'KB-newer' })]);

    const view = await loadDevicePatchApprovalView(DEV, ORG);

    expect(view.byPatchId.get(P1)?.state).toBe('auto_approved');
  });
});
