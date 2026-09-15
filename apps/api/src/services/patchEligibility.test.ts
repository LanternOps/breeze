/**
 * AI patch agent W02 (#5748) — the shared install-eligibility resolver.
 *
 * Two layers under test:
 *  - `evaluatePatchInstallEligibility` — config injected, three Drizzle reads
 *    (org partner → outstanding device_patches ⋈ patches → partner approvals),
 *    exactly the sequence `resolveApprovedPatchesForDevice` has always issued.
 *  - `resolvePatchInstallEligibility` — the LIVE composition the AI path and
 *    the release-time effect digest use: device-in-org read → effective patch
 *    config (mocked `featureConfigResolver` / `configPolicyPatching`) → ring
 *    deferral row → the evaluator above.
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

vi.mock('./featureConfigResolver', () => ({
  resolvePatchConfigDetailsForDevice: vi.fn(),
}));
vi.mock('./configPolicyPatching', () => ({
  loadPolicyLocalPatchConfig: vi.fn(),
}));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));

import { db } from '../db';
import { resolvePatchConfigDetailsForDevice } from './featureConfigResolver';
import { loadPolicyLocalPatchConfig } from './configPolicyPatching';
import { captureException } from './sentry';
import type { ApprovalEvaluationConfig } from './patchApprovalEvaluator';
import {
  evaluatePatchInstallEligibility,
  resolveApprovedPatchesForDevice,
  resolvePatchInstallEligibility,
} from './patchEligibility';

const ORG = '11111111-1111-1111-1111-111111111111';
const DEV = '22222222-2222-2222-2222-222222222222';
const RING = '33333333-3333-3333-3333-333333333333';
const OTHER_RING = '33333333-3333-3333-3333-333333333399';
const PARTNER = '44444444-4444-4444-4444-444444444444';
const P1 = 'aaaaaaaa-0000-0000-0000-000000000001';
const P2 = 'aaaaaaaa-0000-0000-0000-000000000002';
const P3 = 'aaaaaaaa-0000-0000-0000-000000000003';

type Row = {
  devicePatchId: string; patchId: string; externalId: string; title: string;
  category: string | null; severity: string | null; releaseDate: string | null;
  requiresReboot: boolean; source: string; packageId: string | null; version: string | null;
  firstSeenAt: Date | null; status: string; supersededBy: string | null;
};
const row = (o: Partial<Row>): Row => ({
  devicePatchId: `dp-${o.patchId ?? P1}`, patchId: P1, externalId: 'KB1', title: 'A patch',
  category: 'security', severity: 'critical', releaseDate: '2020-01-01', requiresReboot: false,
  source: 'microsoft', packageId: null, version: null, firstSeenAt: null, status: 'pending',
  supersededBy: null, ...o,
});
type Approval = { patchId: string; status: string; ringId: string | null };

function chain(resolveAt: 'where' | 'limit', rows: unknown[]) {
  const c: Record<string, unknown> = {};
  c.from = vi.fn(() => c);
  c.innerJoin = vi.fn(() => c);
  c.leftJoin = vi.fn(() => c);
  c.where = vi.fn(() => (resolveAt === 'where' ? Promise.resolve(rows) : c));
  c.limit = vi.fn(() => Promise.resolve(rows));
  return c;
}

/** The three reads the config-injected evaluator issues, in order. */
function mockEvaluatorReads(pending: Row[], approvals: Approval[], partnerId: string | null = PARTNER) {
  vi.mocked(db.select)
    .mockReturnValueOnce(chain('limit', partnerId ? [{ partnerId }] : []) as never)
    .mockReturnValueOnce(chain('where', pending) as never)
    .mockReturnValueOnce(chain('where', approvals) as never);
}

const ringConfig = (o: Partial<ApprovalEvaluationConfig> = {}): ApprovalEvaluationConfig => ({
  ringId: RING,
  ringPartnerId: PARTNER,
  categoryRules: [],
  autoApprove: {},
  deferralDays: 0,
  ...o,
});

beforeEach(() => {
  vi.mocked(db.select).mockReset();
  vi.mocked(resolvePatchConfigDetailsForDevice).mockReset();
  vi.mocked(loadPolicyLocalPatchConfig).mockReset();
});

describe('evaluatePatchInstallEligibility — the decision, with a reason for every exclusion', () => {
  it("a manual approval for the DEVICE'S ring makes a patch eligible", async () => {
    mockEvaluatorReads([row({ patchId: P1 })], [{ patchId: P1, status: 'approved', ringId: RING }]);
    const res = await evaluatePatchInstallEligibility({ deviceId: DEV, orgId: ORG, config: ringConfig() });
    expect(res.eligible.map((e) => e.patchId)).toEqual([P1]);
    expect(res.eligible[0]).toMatchObject({ devicePatchId: `dp-${P1}`, approvalReason: 'manual', requiresReboot: false });
    expect(res.ineligible).toEqual([]);
    expect(res.ringId).toBe(RING);
    expect(typeof res.resolvedAt).toBe('string');
  });

  it('a manual approval for a DIFFERENT ring does NOT (the routes/devices/patches.ts:183-186 bug)', async () => {
    mockEvaluatorReads([row({ patchId: P1 })], [{ patchId: P1, status: 'approved', ringId: OTHER_RING }]);
    const res = await evaluatePatchInstallEligibility({ deviceId: DEV, orgId: ORG, config: ringConfig() });
    expect(res.eligible).toEqual([]);
    expect(res.ineligible).toContainEqual({ patchId: P1, reason: 'awaiting_manual_approval' });
  });

  it('a partner-wide blanket approval (ring_id NULL) applies to every ring', async () => {
    mockEvaluatorReads([row({ patchId: P1 })], [{ patchId: P1, status: 'approved', ringId: null }]);
    const res = await evaluatePatchInstallEligibility({ deviceId: DEV, orgId: ORG, config: ringConfig({ ringId: OTHER_RING }) });
    expect(res.eligible.map((e) => e.patchId)).toEqual([P1]);
  });

  it('reports held_by_deferral before the deferral window elapses and eligible after', async () => {
    const config = ringConfig({ autoApprove: { enabled: true, severities: ['critical'], deferralDays: 7 } });
    const releasedTwoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
    mockEvaluatorReads([row({ patchId: P1, releaseDate: releasedTwoDaysAgo })], []);
    const held = await evaluatePatchInstallEligibility({ deviceId: DEV, orgId: ORG, config });
    expect(held.ineligible).toEqual([{ patchId: P1, reason: 'held_by_deferral' }]);

    const releasedTenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
    vi.mocked(db.select).mockReset();
    mockEvaluatorReads([row({ patchId: P1, releaseDate: releasedTenDaysAgo })], []);
    const clear = await evaluatePatchInstallEligibility({ deviceId: DEV, orgId: ORG, config });
    expect(clear.eligible.map((e) => e.patchId)).toEqual([P1]);
    expect(clear.eligible[0]!.approvalReason).toBe('ring_auto_approve');
  });

  it('anchors a third-party patch deferral on device_patches.created_at when release_date is null', async () => {
    const config = ringConfig({
      sources: ['os', 'third_party'],
      autoApprove: { enabled: true, severities: ['critical'], thirdPartyApps: true, deferralDays: 7 },
    });
    mockEvaluatorReads([row({ patchId: P1, source: 'third_party', releaseDate: null, firstSeenAt: new Date(Date.now() - 2 * 86_400_000) })], []);
    const held = await evaluatePatchInstallEligibility({ deviceId: DEV, orgId: ORG, config });
    expect(held.ineligible).toEqual([{ patchId: P1, reason: 'held_by_deferral' }]);

    vi.mocked(db.select).mockReset();
    mockEvaluatorReads([row({ patchId: P1, source: 'third_party', releaseDate: null, firstSeenAt: new Date(Date.now() - 10 * 86_400_000) })], []);
    const clear = await evaluatePatchInstallEligibility({ deviceId: DEV, orgId: ORG, config });
    expect(clear.eligible.map((e) => e.patchId)).toEqual([P1]);
  });

  it('fails CLOSED when neither anchor exists', async () => {
    const config = ringConfig({ autoApprove: { enabled: true, severities: ['critical'], deferralDays: 7 } });
    mockEvaluatorReads([row({ patchId: P1, releaseDate: null, firstSeenAt: null })], []);
    const res = await evaluatePatchInstallEligibility({ deviceId: DEV, orgId: ORG, config });
    expect(res.eligible).toEqual([]);
    expect(res.ineligible).toEqual([{ patchId: P1, reason: 'held_by_deferral' }]);
  });

  it('reports blocked_by_category for an excluded category and blocked_by_app_rule for a denied app', async () => {
    const config = ringConfig({
      excludeCategories: ['drivers'],
      sources: ['os', 'third_party'],
      apps: [{ source: 'third_party', packageId: 'Mozilla.Firefox', action: 'block' }],
      autoApprove: { enabled: true, severities: ['critical'], thirdPartyApps: true },
    });
    mockEvaluatorReads([
      row({ patchId: P1, category: 'drivers' }),
      row({ patchId: P2, source: 'third_party', packageId: 'mozilla.firefox', version: '1.0' }),
      row({ patchId: P3 }),
    ], []);
    const res = await evaluatePatchInstallEligibility({ deviceId: DEV, orgId: ORG, config });
    expect(res.ineligible).toEqual(expect.arrayContaining([
      { patchId: P1, reason: 'blocked_by_category' },
      { patchId: P2, reason: 'blocked_by_app_rule' },
    ]));
    expect(res.eligible.map((e) => e.patchId)).toEqual([P3]);
  });

  it('reports blocked_by_source when the policy sources exclude the patch', async () => {
    mockEvaluatorReads([row({ patchId: P1, source: 'third_party' })], [{ patchId: P1, status: 'approved', ringId: null }]);
    const res = await evaluatePatchInstallEligibility({ deviceId: DEV, orgId: ORG, config: ringConfig({ sources: ['os'] }) });
    expect(res.ineligible).toEqual([{ patchId: P1, reason: 'blocked_by_source' }]);
  });

  it('reports superseded when patches.superseded_by is set — only when asked to', async () => {
    mockEvaluatorReads([row({ patchId: P1, supersededBy: 'KB-newer' })], [{ patchId: P1, status: 'approved', ringId: null }]);
    const ai = await evaluatePatchInstallEligibility({ deviceId: DEV, orgId: ORG, config: ringConfig(), excludeSuperseded: true });
    expect(ai.ineligible).toEqual([{ patchId: P1, reason: 'superseded' }]);

    // The executor path never excluded superseded patches; parity is preserved
    // until that gap is fixed on its own (recorded as a follow-up).
    vi.mocked(db.select).mockReset();
    mockEvaluatorReads([row({ patchId: P1, supersededBy: 'KB-newer' })], [{ patchId: P1, status: 'approved', ringId: null }]);
    const executor = await evaluatePatchInstallEligibility({ deviceId: DEV, orgId: ORG, config: ringConfig() });
    expect(executor.eligible.map((e) => e.patchId)).toEqual([P1]);
  });

  it('reports not_outstanding for status = missing (the tombstone) as well as installed, and for an unknown id', async () => {
    mockEvaluatorReads([
      row({ patchId: P1, status: 'missing' }),
      row({ patchId: P2, status: 'installed' }),
    ], [{ patchId: P1, status: 'approved', ringId: null }, { patchId: P2, status: 'approved', ringId: null }]);
    const res = await evaluatePatchInstallEligibility({ deviceId: DEV, orgId: ORG, config: ringConfig(), patchIds: [P1, P2, P3] });
    expect(res.eligible).toEqual([]);
    expect(res.ineligible).toEqual(expect.arrayContaining([
      { patchId: P1, reason: 'not_outstanding' },
      { patchId: P2, reason: 'not_outstanding' },
      { patchId: P3, reason: 'not_outstanding' },
    ]));
    expect(res.ineligible).toHaveLength(3);
  });

  it('reports no_ring_resolved when the device matches no ring and nothing is manually approved', async () => {
    mockEvaluatorReads([row({ patchId: P1 })], []);
    const res = await evaluatePatchInstallEligibility({ deviceId: DEV, orgId: ORG, config: ringConfig({ ringId: null, ringPartnerId: null }) });
    expect(res.ineligible).toEqual([{ patchId: P1, reason: 'no_ring_resolved' }]);
    expect(res.ringId).toBeNull();
  });

  it('reports awaiting_manual_approval when the ring exists but auto-approve does not admit the patch', async () => {
    mockEvaluatorReads([row({ patchId: P1, severity: 'low' })], []);
    const res = await evaluatePatchInstallEligibility({
      deviceId: DEV, orgId: ORG, config: ringConfig({ autoApprove: { enabled: true, severities: ['critical'] } }),
    });
    expect(res.ineligible).toEqual([{ patchId: P1, reason: 'awaiting_manual_approval' }]);
  });

  it('narrows to the requested patchIds and never widens beyond them', async () => {
    mockEvaluatorReads([row({ patchId: P1 }), row({ patchId: P2 })], [
      { patchId: P1, status: 'approved', ringId: null },
      { patchId: P2, status: 'approved', ringId: null },
    ]);
    const res = await evaluatePatchInstallEligibility({ deviceId: DEV, orgId: ORG, config: ringConfig(), patchIds: [P2] });
    expect(res.eligible.map((e) => e.patchId)).toEqual([P2]);
    expect(res.ineligible).toEqual([]);
  });

  it('pins the outstanding read to the org — device_patches.org_id is the tenant boundary, not the device id', async () => {
    mockEvaluatorReads([row({ patchId: P1 })], []);
    await evaluatePatchInstallEligibility({ deviceId: DEV, orgId: ORG, config: ringConfig() });
    const pendingChain = vi.mocked(db.select).mock.results[1]!.value as { where: ReturnType<typeof vi.fn> };
    const condition = JSON.stringify(pendingChain.where.mock.calls[0]![0]);
    expect(condition).toContain(ORG);
    expect(condition).toContain(DEV);
  });

  it('an org without a partner has no approvals: every candidate is ineligible, never thrown', async () => {
    mockEvaluatorReads([], [], null);
    const res = await evaluatePatchInstallEligibility({ deviceId: DEV, orgId: ORG, config: ringConfig(), patchIds: [P1] });
    expect(res.eligible).toEqual([]);
    expect(res.ineligible).toEqual([{ patchId: P1, reason: 'not_outstanding' }]);
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(1);
  });
});

describe('resolveApprovedPatchesForDevice — golden-fixture parity with the pre-extraction evaluator', () => {
  it('returns exactly what it returned before the extraction (shape, order, fields)', async () => {
    mockEvaluatorReads([
      row({ patchId: P1, devicePatchId: 'dp-1', externalId: 'KB1', title: 'One', category: 'security', severity: 'critical', requiresReboot: true }),
      row({ patchId: P2, devicePatchId: 'dp-2', externalId: 'KB2', title: 'Two', category: 'updates', severity: 'low' }),
      row({ patchId: P3, devicePatchId: 'dp-3', externalId: 'KB3', title: 'Three', category: 'security', severity: 'important', supersededBy: 'KB9' }),
    ], [{ patchId: P2, status: 'approved', ringId: RING }]);
    const approved = await resolveApprovedPatchesForDevice(DEV, ORG, ringConfig({
      autoApprove: { enabled: true, severities: ['critical', 'important'] },
    }));
    expect(approved).toEqual([
      { patchId: P1, devicePatchId: 'dp-1', externalId: 'KB1', title: 'One', category: 'security', severity: 'critical', requiresReboot: true, approvalReason: 'ring_auto_approve' },
      { patchId: P2, devicePatchId: 'dp-2', externalId: 'KB2', title: 'Two', category: 'updates', severity: 'low', requiresReboot: false, approvalReason: 'manual' },
      // superseded is NOT excluded on the executor path (parity).
      { patchId: P3, devicePatchId: 'dp-3', externalId: 'KB3', title: 'Three', category: 'security', severity: 'important', requiresReboot: false, approvalReason: 'ring_auto_approve' },
    ]);
  });

  it('ignores a ring owned by another partner (cross-partner ring guard) exactly as before', async () => {
    mockEvaluatorReads([row({ patchId: P1 })], [{ patchId: P1, status: 'approved', ringId: RING }]);
    const approved = await resolveApprovedPatchesForDevice(DEV, ORG, ringConfig({ ringPartnerId: 'someone-else' }));
    // Ring-scoped approval for a ring that is ignored → no match.
    expect(approved).toEqual([]);
  });
});

describe('resolvePatchInstallEligibility — the live composition', () => {
  function mockDevice(found: boolean) {
    vi.mocked(db.select).mockReturnValueOnce(chain('limit', found ? [{ id: DEV, orgId: ORG }] : []) as never);
  }
  function mockRingRow(deferralDays: number, partnerId = PARTNER) {
    vi.mocked(db.select).mockReturnValueOnce(chain('limit', [{ deferralDays, partnerId }]) as never);
  }
  const policyLocal = (o: Record<string, unknown> = {}) => ({
    configPolicyId: 'cp-1', configPolicyName: 'Workstations', orgId: ORG, featureLinkId: 'fl-1',
    featurePolicyId: RING, sourcePolicyId: 'cp-1', inherited: false,
    settings: { sources: ['os'], autoApprove: false, autoApproveSeverities: [], autoApproveDeferralDays: 0, apps: [] },
    ring: {
      classification: 'valid_ring', valid: true, ringId: RING, ringName: 'Ring A',
      categoryRules: [{ category: 'security', autoApprove: true }], categories: [], excludeCategories: [], autoApprove: {},
    },
    ...o,
  });

  it('returns device_not_in_org for every requested id when the device is not in the org', async () => {
    mockDevice(false);
    const res = await resolvePatchInstallEligibility({ deviceId: DEV, orgId: ORG, patchIds: [P1, P2] });
    expect(res.eligible).toEqual([]);
    expect(res.ineligible).toEqual([{ patchId: P1, reason: 'device_not_in_org' }, { patchId: P2, reason: 'device_not_in_org' }]);
    expect(res.ringId).toBeNull();
    expect(resolvePatchConfigDetailsForDevice).not.toHaveBeenCalled();
  });

  it("resolves the device's effective ring live, reads its deferral window, and excludes superseded patches", async () => {
    mockDevice(true);
    vi.mocked(resolvePatchConfigDetailsForDevice).mockResolvedValue({ configPolicyId: 'cp-1' } as never);
    vi.mocked(loadPolicyLocalPatchConfig).mockResolvedValue(policyLocal() as never);
    mockRingRow(30);
    mockEvaluatorReads([
      row({ patchId: P1, releaseDate: new Date(Date.now() - 2 * 86_400_000).toISOString() }),
      row({ patchId: P2, supersededBy: 'KB-newer' }),
      row({ patchId: P3 }),
    ], []);
    const res = await resolvePatchInstallEligibility({ deviceId: DEV, orgId: ORG, patchIds: [P1, P2, P3] });
    expect(res.ringId).toBe(RING);
    expect(res.ineligible).toEqual(expect.arrayContaining([
      { patchId: P1, reason: 'held_by_deferral' },
      { patchId: P2, reason: 'superseded' },
    ]));
    expect(res.eligible.map((e) => e.patchId)).toEqual([P3]);
    expect(res.eligible[0]!.approvalReason).toBe('category_rule');
    expect(loadPolicyLocalPatchConfig).toHaveBeenCalledWith('cp-1');
  });

  it('with no patch policy at all, only a manual partner-wide approval can admit a patch', async () => {
    mockDevice(true);
    vi.mocked(resolvePatchConfigDetailsForDevice).mockResolvedValue(null);
    mockEvaluatorReads([row({ patchId: P1 }), row({ patchId: P2 })], [{ patchId: P1, status: 'approved', ringId: null }]);
    const res = await resolvePatchInstallEligibility({ deviceId: DEV, orgId: ORG });
    expect(res.ringId).toBeNull();
    expect(res.eligible.map((e) => e.patchId)).toEqual([P1]);
    expect(res.ineligible).toEqual([{ patchId: P2, reason: 'no_ring_resolved' }]);
    expect(loadPolicyLocalPatchConfig).not.toHaveBeenCalled();
  });

  it('fails CLOSED when the ring vanishes between resolution and the deferral read — no ring, loudly', async () => {
    mockDevice(true);
    vi.mocked(resolvePatchConfigDetailsForDevice).mockResolvedValue({ configPolicyId: 'cp-1' } as never);
    vi.mocked(loadPolicyLocalPatchConfig).mockResolvedValue(policyLocal() as never);
    // The ring row read comes back empty (deleted mid-flight).
    vi.mocked(db.select).mockReturnValueOnce(chain('limit', []) as never);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Category rule on the (vanished) ring would otherwise admit P1.
    mockEvaluatorReads([row({ patchId: P1 })], []);
    const res = await resolvePatchInstallEligibility({ deviceId: DEV, orgId: ORG });
    expect(res.ringId).toBeNull();
    expect(res.eligible).toEqual([]);
    expect(res.ineligible).toEqual([{ patchId: P1, reason: 'no_ring_resolved' }]);
    expect(captureException).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('treats an invalid ring reference as no ring, keeping the policy sources/app rules', async () => {
    mockDevice(true);
    vi.mocked(resolvePatchConfigDetailsForDevice).mockResolvedValue({ configPolicyId: 'cp-1' } as never);
    vi.mocked(loadPolicyLocalPatchConfig).mockResolvedValue(policyLocal({
      ring: { classification: 'missing_target', valid: false, ringId: null, ringName: null, categoryRules: [], categories: [], excludeCategories: [], autoApprove: {} },
    }) as never);
    mockEvaluatorReads([row({ patchId: P1, source: 'third_party' })], [{ patchId: P1, status: 'approved', ringId: null }]);
    const res = await resolvePatchInstallEligibility({ deviceId: DEV, orgId: ORG });
    expect(res.ringId).toBeNull();
    expect(res.ineligible).toEqual([{ patchId: P1, reason: 'blocked_by_source' }]);
  });
});
