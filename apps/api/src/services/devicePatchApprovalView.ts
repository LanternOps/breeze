/**
 * Ring-aware approval state for the device Patches tab (#7625).
 *
 * The tab used to show `approvalStatus`, which is only "is there a manual
 * partner-wide approval row" — so every patch the device's update ring would
 * auto-approve read "Pending approval" until the scheduled job ran. This view
 * asks the SAME evaluator the job uses (`evaluatePatchInstallEligibility` over
 * the device's live effective config) and maps its verdict to display states.
 * No approval rule is re-implemented here.
 *
 * Parity choice: superseded patches are NOT excluded, matching the scheduled
 * job (`resolveApprovedPatchesForDevice`), because the question the tab
 * answers is "what will the next scheduled run do with this patch?".
 *
 * Read-only. PRECONDITION: the caller's DB context can SELECT the device-org
 * partner's `patch_policies` / `patch_approvals` rows — a system context, or
 * (#7647) any context whose own partner is that partner, via those tables'
 * own-partner SELECT branch. Wrap the call in `readOwnPartnerAxisRows` so a
 * context that cannot see them escapes instead of silently reading zero rows.
 * The caller must also have access-checked `deviceId` against `orgId`.
 */
import type {
  DevicePatchApprovalEvaluation,
  DevicePatchApprovalState,
  DevicePatchEffectiveApproval,
} from '@breeze/shared';
import {
  evaluatePatchInstallEligibility,
  resolveDevicePatchEvaluation,
  type PatchIneligibleEntry,
} from './patchEligibility';
import type { ApprovalReason } from './patchApprovalEvaluator';

export interface DevicePatchApprovalView {
  evaluation: DevicePatchApprovalEvaluation;
  byPatchId: Map<string, DevicePatchEffectiveApproval>;
}

function approvedState(reason: ApprovalReason): DevicePatchApprovalState {
  return reason === 'manual' ? 'approved' : 'auto_approved';
}

/** Null for reasons that cannot describe an outstanding patch on an access-checked device. */
function ineligibleState(entry: PatchIneligibleEntry): DevicePatchApprovalState | null {
  switch (entry.reason) {
    case 'held_by_deferral':
      return 'deferred';
    case 'awaiting_manual_approval':
    case 'no_ring_resolved':
      return 'needs_approval';
    case 'blocked_by_source':
    case 'blocked_by_category':
    case 'blocked_by_app_rule':
      return 'excluded';
    case 'not_outstanding':
    case 'superseded':
    case 'device_not_in_org':
      return null;
  }
}

export async function loadDevicePatchApprovalView(deviceId: string, orgId: string): Promise<DevicePatchApprovalView> {
  const { config, ringName } = await resolveDevicePatchEvaluation(deviceId);
  const verdict = await evaluatePatchInstallEligibility({ deviceId, orgId, config, excludeSuperseded: false });

  const byPatchId = new Map<string, DevicePatchEffectiveApproval>();
  for (const entry of verdict.eligible) {
    byPatchId.set(entry.patchId, { state: approvedState(entry.approvalReason), reason: entry.approvalReason, holdUntil: null });
  }
  for (const entry of verdict.ineligible) {
    const state = ineligibleState(entry);
    if (!state) {
      // Not reachable for an access-checked device's outstanding rows; if it
      // happens the patch keeps its manual-only badge — log why.
      console.warn(`[devicePatchApprovalView] device ${deviceId}: patch ${entry.patchId} has no display state for reason '${entry.reason}'`);
      continue;
    }
    byPatchId.set(entry.patchId, {
      state,
      reason: entry.reason,
      holdUntil: state === 'deferred' ? entry.holdUntil ?? null : null,
    });
  }

  // verdict.ringId is post cross-partner guard; only name a ring the decision used.
  const ring = verdict.ringId ? { id: verdict.ringId, name: ringName } : null;
  return { evaluation: { available: true, ring }, byPatchId };
}
