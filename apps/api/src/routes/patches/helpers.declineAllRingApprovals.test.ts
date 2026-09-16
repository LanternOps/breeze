import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    execute: vi.fn(async () => undefined),
  },
}));

vi.mock('../../db/schema', () => ({
  organizations: { id: 'organizations.id', partnerId: 'organizations.partner_id' },
  patchPolicies: { id: 'patch_policies.id', partnerId: 'patch_policies.partner_id' },
  patchApprovals: {
    partnerId: 'patch_approvals.partner_id',
    patchId: 'patch_approvals.patch_id',
    ringId: 'patch_approvals.ring_id',
  },
}));

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

import { db } from '../../db';
import { PartnerWideWriteDeniedError } from '../../services/partnerWideAccess';
import { declineAllRingApprovals } from './helpers';

const PARTNER_ID = '11111111-1111-1111-1111-111111111111';
const PATCH_ID = '22222222-2222-4222-8222-222222222222';
const AUTH = { scope: 'partner' as const, partnerOrgAccess: 'all' as const };

function mockExistingRows(rows: Array<{ ringId: string | null }>) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(rows),
    }),
  } as never);
}

// drizzle's `sql` tagged template embeds interpolated primitive values
// (string/null/etc.) directly as queryChunks entries, interleaved with
// StringChunk wrapper objects carrying the literal SQL text between them.
// Filtering out the StringChunk wrappers recovers the BOUND parameter values
// in template order — so a test can assert on the actual ring_id value each
// db.execute call was bound to, not just the call count. Without this, a bug
// that silently reused one ringId (or dropped the loop variable and always
// bound null) for every write would still pass a call-count-only assertion.
function boundParams(query: unknown): unknown[] {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks.filter((c) => !(c && (c as { constructor?: { name?: string } }).constructor?.name === 'StringChunk'));
}

// upsertPatchApproval's INSERT binds, in order: partnerId, patchId, ringId,
// status, approvedBy, approvedAt, deferUntil, notes, NIL_UUID (the
// ON CONFLICT COALESCE fallback). ringId is the 3rd bound value (index 2).
const RING_ID_PARAM_INDEX = 2;

describe('declineAllRingApprovals (#5585)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('declines every distinct ring row for the patch, plus the blanket row', async () => {
    mockExistingRows([{ ringId: 'ring-a' }, { ringId: 'ring-b' }, { ringId: null }]);

    const result = await declineAllRingApprovals(PARTNER_ID, PATCH_ID, 'nasty bug', AUTH);

    // 3 upserts: ring-a, ring-b, and the blanket (deduped — null was already present).
    expect(db.execute).toHaveBeenCalledTimes(3);
    expect(result.ringIds.sort()).toEqual([null, 'ring-a', 'ring-b'].sort());
    expect(result.failedRingIds).toEqual([]);
  });

  // Guards against a loop bug that writes the SAME ringId (e.g. always null)
  // on every iteration instead of the actual per-ring value — the exact
  // failure mode #5585 itself was.
  it('binds a distinct ringId parameter to each write, not the same one repeated', async () => {
    mockExistingRows([{ ringId: 'ring-a' }, { ringId: 'ring-b' }]);

    await declineAllRingApprovals(PARTNER_ID, PATCH_ID, null, AUTH);

    const calls = vi.mocked(db.execute).mock.calls;
    expect(calls).toHaveLength(3); // ring-a, ring-b, blanket
    const boundRingIds = calls.map(([query]) => boundParams(query)[RING_ID_PARAM_INDEX]);
    expect(boundRingIds.sort()).toEqual([null, 'ring-a', 'ring-b'].sort());
  });

  it('still declines the blanket row when no ring approval exists yet', async () => {
    mockExistingRows([]);

    const result = await declineAllRingApprovals(PARTNER_ID, PATCH_ID, null, AUTH);

    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(result.ringIds).toEqual([null]);
    expect(result.failedRingIds).toEqual([]);
  });

  it('does not duplicate a ring already present in existing rows', async () => {
    mockExistingRows([{ ringId: 'ring-a' }, { ringId: 'ring-a' }]);

    const result = await declineAllRingApprovals(PARTNER_ID, PATCH_ID, null, AUTH);

    // ring-a deduped to one write + the blanket = 2 total.
    expect(db.execute).toHaveBeenCalledTimes(2);
    expect(result.ringIds.sort()).toEqual([null, 'ring-a'].sort());
  });

  // A transient failure on ONE ring must not roll back or hide progress on
  // the others — the caller needs to know exactly which rings did and didn't
  // clear, not just "it failed" (would otherwise reintroduce the same
  // "declined in the UI but not really" gap #5585 was filed for).
  it('records a per-ring failure without losing the rings that did succeed', async () => {
    mockExistingRows([{ ringId: 'ring-a' }, { ringId: 'ring-b' }]);
    vi.mocked(db.execute)
      .mockResolvedValueOnce(undefined as never) // ring-a succeeds
      .mockRejectedValueOnce(new Error('connection reset')) // ring-b fails
      .mockResolvedValueOnce(undefined as never); // blanket succeeds

    const result = await declineAllRingApprovals(PARTNER_ID, PATCH_ID, null, AUTH);

    expect(result.ringIds.sort()).toEqual([null, 'ring-a'].sort());
    expect(result.failedRingIds).toEqual(['ring-b']);
    // All three writes were attempted despite the middle one failing.
    expect(db.execute).toHaveBeenCalledTimes(3);
  });

  // Authorization failures are not "one ring among others" — the caller never
  // had authority to write ANY of these rows, so this must abort the whole
  // call rather than being swallowed into failedRingIds.
  it('propagates PartnerWideWriteDeniedError immediately instead of recording it as a failed ring', async () => {
    mockExistingRows([{ ringId: 'ring-a' }]);
    const deniedAuth = { scope: 'partner' as const, partnerOrgAccess: 'selected' as const };

    await expect(declineAllRingApprovals(PARTNER_ID, PATCH_ID, null, deniedAuth))
      .rejects.toBeInstanceOf(PartnerWideWriteDeniedError);
    expect(db.execute).not.toHaveBeenCalled();
  });
});
