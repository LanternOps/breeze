/**
 * Manual patch decisions (`patch_approvals`) — the ONE latest-wins resolution
 * between `approved` and `rejected` rows (#9369, #9485).
 *
 * A partner can hold several decision rows per patch: a blanket row
 * (`ring_id IS NULL`) and one per ring. A decline is a TERMINAL deny — it must
 * beat an older approval — so every reader of `patch_approvals` resolves the
 * rows through `resolveLatestManualDecisions` rather than selecting
 * `status = 'approved'` alone. Readers:
 *
 *  - `patchEligibility.ts` (ring-aware; scope = the device's ring)
 *  - `routes/devices/patches.ts` manual-install gate (ring-agnostic)
 *  - `vulnerabilityRemediation.ts` (ring-agnostic)
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { patchApprovals } from '../db/schema';

export interface ManualDecisionRow {
  patchId: string;
  status: string;
  ringId: string | null;
  updatedAt: Date | string | null;
}

/**
 * Which rows apply:
 *  - `{ ringId }` — this ring's rows plus partner-wide (null ring) rows.
 *  - `'any'` — every row, for readers with no ring context. Still latest-wins
 *    across all rings: a decline denies only until a NEWER approval (any ring
 *    or blanket) supersedes it. It is not a permanent per-ring veto; the full
 *    ring-aware verdict lives in `patchEligibility.ts`.
 */
export type ManualDecisionScope = { ringId: string | null } | 'any';

export interface ManualDecisions {
  approved: Set<string>;
  declined: Set<string>;
}

/**
 * Latest decision wins (`updatedAt`); a TIE resolves to the decline
 * (fail-closed). A missing/invalid timestamp counts as time 0 (oldest) —
 * unreachable in practice, `updated_at` is NOT NULL. Rows with a status other
 * than approved/rejected are ignored.
 */
export function resolveLatestManualDecisions(
  rows: readonly ManualDecisionRow[],
  scope: ManualDecisionScope,
): ManualDecisions {
  const latest = new Map<string, { status: string; at: number }>();
  for (const row of rows) {
    if (row.status !== 'approved' && row.status !== 'rejected') continue;
    if (scope !== 'any' && row.ringId !== scope.ringId && row.ringId !== null) continue;
    const t = row.updatedAt ? new Date(row.updatedAt).getTime() : 0;
    const at = Number.isFinite(t) ? t : 0;
    const prev = latest.get(row.patchId);
    if (!prev || at > prev.at || (at === prev.at && row.status === 'rejected')) {
      latest.set(row.patchId, { status: row.status, at });
    }
  }
  const approved = new Set<string>();
  const declined = new Set<string>();
  for (const [patchId, d] of latest) {
    (d.status === 'rejected' ? declined : approved).add(patchId);
  }
  return { approved, declined };
}

/**
 * The partner's approved/rejected decision rows for these patches. Returns the
 * query itself so a caller can wrap it (e.g. `readOwnPartnerAxisRows`).
 */
export function selectManualDecisionRows(partnerId: string, patchIds: string[]) {
  return db
    .select({
      patchId: patchApprovals.patchId,
      status: patchApprovals.status,
      ringId: patchApprovals.ringId,
      updatedAt: patchApprovals.updatedAt,
    })
    .from(patchApprovals)
    .where(
      and(
        eq(patchApprovals.partnerId, partnerId),
        inArray(patchApprovals.patchId, patchIds),
        inArray(patchApprovals.status, ['approved', 'rejected']),
      ),
    );
}
