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
] as const;
export type PatchPlanRefusalReason = (typeof PATCH_PLAN_REFUSAL_REASONS)[number];

export type PatchPlanItemDisposition = 'recorded' | 'refused';

/** The persister's record for one submitted item (by index). */
export interface PatchPlanItemRecord {
  index: number;
  class: PatchPlanItemClass;
  deviceId: string | null;
  disposition: PatchPlanItemDisposition;
  reason?: PatchPlanRefusalReason;
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
  jobResultIds: ReadonlySet<string>;
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
  evidenceTruncated: boolean;
}
