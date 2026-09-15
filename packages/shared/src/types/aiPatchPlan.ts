import type { AiSweepSeverity } from './aiAgentSchedules';

/**
 * AI patch agent (W01) — the patch plan a `patch`-profile run returns through
 * its one outcome tool, `submit_patch_plan`.
 *
 * The item class union is the op vocabulary handed to AI Operator P4-3 (plan
 * index, "Handoff contract"): P4-3's recipe steps map onto these classes and
 * must not invent a parallel vocabulary. W01 is findings-only — no class mints
 * an action intent in this wave; `install` becomes an approval card in W02.
 *
 *   install            device-scoped: these outstanding patches should go on
 *                      this device (a proposal a technician must approve).
 *   approval_advisory  partner/ring-scoped: these updates need a manual
 *                      approval decision. Never device-scoped and never
 *                      writes a `patch_approvals` row (OD-3 A).
 *   reboot_plan        device-scoped: reboot inside an EXISTING resolved
 *                      maintenance window. Never a synthesised time. W01
 *                      evidence resolves no windows, so every one is refused.
 *   chase              device-scoped: failed patch work to retry. W03 fills
 *                      the failure evidence; W01 refuses every one.
 *   escalation         something a human must look at.
 */
export const PATCH_PLAN_ITEM_CLASSES = ['install', 'approval_advisory', 'reboot_plan', 'chase', 'escalation'] as const;
export type PatchPlanItemClass = (typeof PATCH_PLAN_ITEM_CLASSES)[number];

export const PATCH_PLAN_SCHEMA_VERSION = 1 as const;
export const PATCH_PLAN_MAX_ITEMS = 100;
export const PATCH_PLAN_MAX_PATCH_IDS_PER_ITEM = 50;
export const PATCH_PLAN_MAX_JOB_RESULT_IDS_PER_ITEM = 50;
export const PATCH_PLAN_TITLE_MAX_CHARS = 120;
export const PATCH_PLAN_DETAIL_MAX_CHARS = 1000;
export const PATCH_PLAN_SUMMARY_MAX_CHARS = 600;
export const PATCH_PLAN_EVIDENCE_REF_MAX_CHARS = 200;

/**
 * AI patch agent W03 (#5749) — the failure classes `classifyPatchFailure`
 * (apps/api `services/patchFailureClass.ts`) derives from a failed
 * `patch_job_results` row's SERVER-SIDE fields. Never from model prose.
 *
 *   transient      the agent never answered (server-side timeout) or the
 *                  install was interrupted — worth one bounded retry.
 *   needs_reboot   the install is waiting on a restart. NOT a failure to
 *                  retry: it routes to the reboot plan (W04).
 *   disk_space     the device is out of disk — retryable once someone has
 *                  freed space, so the card names the cause.
 *   store_corrupt  the component store / update cache is damaged — a retry
 *                  after repair is reasonable.
 *   permanent      the vendor says the update does not apply here.
 *   unknown        the message matched nothing. A class we cannot name is a
 *                  class we cannot bound, so it escalates.
 */
export const PATCH_FAILURE_CLASSES = [
  'transient', 'needs_reboot', 'disk_space', 'store_corrupt', 'permanent', 'unknown',
] as const;
export type PatchFailureClass = (typeof PATCH_FAILURE_CLASSES)[number];

/** The classes a `chase` (bounded re-install) may target. Everything else escalates. */
export const PATCH_FAILURE_RETRYABLE_CLASSES: ReadonlySet<PatchFailureClass> = new Set<PatchFailureClass>([
  'transient', 'disk_space', 'store_corrupt',
]);

/**
 * A chase is refused once the evidence already counts this many failed
 * attempts for the (device, patch, class) group — the run proposes an
 * escalation instead. Attempts are counted from `patch_job_results` rows in
 * `failed` within the evidence window; nothing retries itself.
 */
export const PATCH_CHASE_MAX_ATTEMPTS = 2;

/** Fleet posture the model reports at the top of the plan. */
export interface PatchPlanPosture {
  /** 0-100. */
  compliancePct: number;
  devicesAtRisk: number;
  /** Null when nothing is outstanding. */
  oldestOutstandingDays: number | null;
}

/** One item the model submits. Per-class field rules live in the validator. */
export interface PatchPlanItem {
  class: PatchPlanItemClass;
  severity: AiSweepSeverity;
  deviceId?: string | null;
  patchIds?: string[];
  jobResultIds?: string[];
  windowId?: string | null;
  /** One line, ≤ 120 chars — what an approval card would show. */
  title: string;
  detail: string;
  /** Opaque section/row reference into the evidence bundle. */
  evidenceRef: string;
  /**
   * W03: `chase`/`escalation` only — the class the EVIDENCE computed for the
   * cited failed work. The model may quote it, never assign it: the persister
   * refuses a citation that disagrees with the evidence.
   */
  failureClass?: PatchFailureClass;
  /** W03: `chase`/`escalation` only — the evidence's attempt count for the cited group, quoted. */
  attemptCount?: number;
}

/** What the model submits through `submit_patch_plan`. */
export interface PatchPlanSubmission {
  summary: string;
  posture: PatchPlanPosture;
  items: PatchPlanItem[];
}

/**
 * Why the server refused an item. A DISPLAY enum, never an `Error.message`
 * (the `sweepFindings.ts` rule): these render verbatim on the run trace.
 */
export const PATCH_PLAN_REFUSAL_REASONS = [
  'device_not_in_evidence',
  'device_not_in_org',
  'patch_not_in_evidence',
  'window_not_resolved',
  'job_result_not_in_evidence',
  // W02 (#5748) — the minting branch after the membership gates.
  /** Every patch the item named is ineligible for that device right now. */
  'no_eligible_patches',
  /** `manage_patches:install` is not in the agent's effective allowlist. */
  'not_allowlisted',
  /** The run's post-run action cap (`run.maxActionsPerRun`) was already spent. */
  'max_actions_per_run',
  /** `createActionIntent` committed then cancelled: nobody can approve. */
  'no_eligible_approvers',
  /** `createActionIntent` threw — the message is logged, never stored. */
  'intent_error',
  // `suppressed` dispositions — `PatchEpisodeSuppressionReason` values.
  'live_intent_exists',
  'recently_rejected',
  'recently_cancelled',
  'recently_completed',
  // W03 (#5749) — the chase gates, before the W02 minting branch.
  /** The cited `failureClass` is not what the evidence computed for that group. */
  'failure_class_mismatch',
  /** The group's class is `needs_reboot`, `permanent` or `unknown` — never re-installed by proposal. */
  'class_not_retryable',
  /** The evidence already counts `PATCH_CHASE_MAX_ATTEMPTS` failed attempts — escalate instead. */
  'chase_attempts_exhausted',
] as const;
export type PatchPlanRefusalReason = (typeof PATCH_PLAN_REFUSAL_REASONS)[number];

/**
 * Why `resolvePatchInstallEligibility` (apps/api `services/patchEligibility.ts`)
 * excluded one patch for one device. Recorded per dropped id on an install
 * item's disposition (`droppedPatchIds`) and rendered verbatim on the run
 * trace — display values, never an `Error.message`.
 */
export const PATCH_INELIGIBLE_REASONS = [
  /** `device_patches.status` is not outstanding (installed, failed, or the `missing` tombstone), or there is no row at all. */
  'not_outstanding',
  /** `patches.superseded_by` is set — a newer update replaces this one. */
  'superseded',
  /** The policy's `sources` filter excludes this patch's source. */
  'blocked_by_source',
  'held_by_deferral',
  'blocked_by_category',
  'blocked_by_app_rule',
  /** No manual approval and no auto-approve rule admits it. */
  'awaiting_manual_approval',
  /** The device resolves to no update ring, so only a manual approval could admit it — and none does. */
  'no_ring_resolved',
  'device_not_in_org',
] as const;
export type PatchIneligibleReason = (typeof PATCH_INELIGIBLE_REASONS)[number];

/**
 * `recorded` — the item was accepted as a finding (every non-`install` class,
 * W01). `intent_created` — an `install` item became a pending device-scoped
 * approval card (W02). `refused` — a gate rejected it before any intent was
 * attempted. `suppressed` — the same (device, patch) problem already has a
 * live or recently-decided card (W02, OD-4 A). `cap_reached` — the run's
 * action budget was spent. `error` — an intent WAS attempted and did not end
 * up pending (mirrors `SweepProposalDisposition`).
 */
export type PatchPlanItemDisposition =
  | 'recorded'
  | 'intent_created'
  | 'refused'
  | 'suppressed'
  | 'cap_reached'
  | 'error';

/** The persister's record for one submitted item (by index). */
export interface PatchPlanItemRecord {
  index: number;
  class: PatchPlanItemClass;
  deviceId: string | null;
  disposition: PatchPlanItemDisposition;
  reason?: PatchPlanRefusalReason;
  /** W02: the pending `action_intents.id` when `disposition === 'intent_created'`. */
  intentId?: string;
  /**
   * W02: the patch ids the resolver dropped from the card, each with why. A
   * multi-patch card carries ONE idempotency key (the first surviving id's);
   * every surviving id is listed in `mintedPatchIds` as an audit trail on the
   * run outcome (the suppression read keys on `action_intents.idempotency_key`
   * alone).
   */
  droppedPatchIds?: Array<{ patchId: string; reason: PatchIneligibleReason }>;
  mintedPatchIds?: string[];
}

/** `ai_agent_runs.outcome.patchPlan` — server-built from a validated submission. */
export interface PatchPlanOutcome {
  schemaVersion: typeof PATCH_PLAN_SCHEMA_VERSION;
  summary: string;
  posture: PatchPlanPosture;
  items: PatchPlanItem[];
  /** Filled by `persistPatchPlan`; `[]` until the finalizer runs. */
  dispositions: PatchPlanItemRecord[];
  /** Copied from the evidence bundle: some section hit a row or byte cap. */
  evidenceTruncated: boolean;
  generatedAt: string;
}

/** What the in-tool referential gate checks a submission against. */
export interface PatchPlanOutcomeRefs {
  deviceIds: ReadonlySet<string>;
  patchIdsByDevice: ReadonlyMap<string, ReadonlySet<string>>;
  windowIds: ReadonlySet<string>;
  /** W03: every failed `patch_job_results.id` the failedWork section showed. */
  jobResultIds: ReadonlySet<string>;
  /**
   * W03: the failedWork groups, keyed `<deviceId>:<patchId>` — what a chase
   * item's cited `failureClass`/`attemptCount` are checked against, and the
   * job result ids that belong to each group. Absent on a W01/W02 bundle.
   */
  failedWorkByDevicePatch?: ReadonlyMap<string, PatchFailedWorkRef>;
}

/** W03: one failedWork evidence group as the persister sees it. */
export interface PatchFailedWorkRef {
  deviceId: string;
  patchId: string;
  failureClass: PatchFailureClass;
  attemptCount: number;
  jobResultIds: readonly string[];
}

/** One plan item on the run-detail DTO. */
export interface AiAgentRunPatchItemDto {
  index: number;
  class: PatchPlanItemClass;
  severity: AiSweepSeverity;
  deviceId: string | null;
  deviceHostname: string | null;
  patchCount: number;
  title: string;
  detail: string;
  disposition: PatchPlanItemDisposition | null;
  reason: PatchPlanRefusalReason | null;
  /** W02: the approval card this item minted, when it did. */
  intentId: string | null;
  /** W02: patch ids the eligibility resolver dropped from the card, with why. */
  droppedPatchIds: Array<{ patchId: string; reason: PatchIneligibleReason }>;
  /** W03: the failure class the item cites (`chase`/`escalation`), else null. */
  failureClass: PatchFailureClass | null;
  /** W03: the attempt count the item cites (`chase`/`escalation`), else null. */
  attemptCount: number | null;
}

/**
 * Safe projection of a `patch`-profile run's outcome for
 * `GET /ai/agents/runs/:runId`. `scheduleId`/`occurrenceKey` are null for a
 * manually-triggered run.
 */
export interface AiAgentRunPatchDto {
  scheduleId: string | null;
  occurrenceKey: string | null;
  summary: string;
  posture: PatchPlanPosture | null;
  items: AiAgentRunPatchItemDto[];
  recordedCount: number;
  refusedCount: number;
  /** W02: items that became a pending approval card. */
  intentCreatedCount: number;
  /** W02: items withheld because the same problem already has a live/recent card. */
  suppressedCount: number;
  /** W03: `escalation` items the run recorded (they never mint). */
  escalationCount: number;
  evidenceTruncated: boolean;
}
