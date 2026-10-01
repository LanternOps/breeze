import type { PatchIneligibleReason } from './aiPatchPlan';

/**
 * Ring-aware approval state of one outstanding patch on one device, as shown
 * on the device Patches tab (#7625). Computed by the same eligibility
 * evaluator the scheduled patch job uses (`services/patchEligibility.ts`), so
 * the tab answers "will the next scheduled run install this?".
 *
 *  - `approved`       — a manual approval (partner-wide, or for this device's ring).
 *  - `auto_approved`  — the device's update ring approves it (category rule or
 *                       ring auto-approve); the next scheduled run installs it.
 *  - `deferred`       — the ring will approve it once its deferral window ends
 *                       (`holdUntil`; null when the patch cannot prove its age).
 *  - `needs_approval` — nothing approves it; it needs a manual approval.
 *  - `excluded`       — the policy's sources, the ring's category filter or an
 *                       app rule keeps it out of scheduled installs entirely.
 *
 * This is display state only. The per-device Install action is still gated on
 * the manual `approvalStatus` field alone (tracked follow-up in
 * routes/devices/patches.ts).
 */
export const DEVICE_PATCH_APPROVAL_STATES = [
  'approved',
  'auto_approved',
  'deferred',
  'needs_approval',
  'excluded',
] as const;
export type DevicePatchApprovalState = (typeof DEVICE_PATCH_APPROVAL_STATES)[number];

/** Why the evaluator approved a patch. Mirrors `ApprovalReason` in apps/api `services/patchApprovalEvaluator.ts`. */
export type DevicePatchApprovedReason =
  | 'manual'
  | 'category_rule'
  | 'ring_auto_approve'
  | 'legacy_auto_approve'
  | 'policy_auto_approve';

export interface DevicePatchEffectiveApproval {
  state: DevicePatchApprovalState;
  /** The evaluator's reason, verbatim — an approval reason or an ineligibility reason. */
  reason: DevicePatchApprovedReason | PatchIneligibleReason;
  /** ISO timestamp the deferral window ends. Set only for `deferred`; null there when the patch has no usable age anchor. */
  holdUntil: string | null;
}

/**
 * Top-level context for the per-patch `effectiveApproval` values on
 * GET /devices/:id/patches. `available: false` means the evaluation failed and
 * per-patch values are absent; clients fall back to `approvalStatus`.
 */
export interface DevicePatchApprovalEvaluation {
  available: boolean;
  /** The update ring the decision was made against; null = no ring (manual approvals only). */
  ring: { id: string; name: string | null } | null;
}
