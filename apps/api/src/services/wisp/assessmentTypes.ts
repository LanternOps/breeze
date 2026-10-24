/**
 * Wisp W05b (#9917) — the assessment run's shared types. Type-only: the run
 * loop (`aiAgents/runLoopTypes.ts`, Task 6), the context loader
 * (`wisp/assessment.ts`, Task 7) and the readiness inventory
 * (`wisp/readiness.ts`, Task 15) all speak these shapes, so they live in one
 * module none of them owns and none of them imports at runtime.
 */
import type { Concern, Watch, WatchKind } from '@breeze/shared';

/** Why an assessment was requested (w00 "Triage engine (W05)" + A33). */
export type AssessmentReason =
  | { kind: 'event'; eventType: string; eventId: string }
  | { kind: 'tick' }
  | { kind: 'watch'; watchId: string }
  | { kind: 'onboarding' };

/**
 * `ai_agent_runs.trigger_ref.wisp` of an assessment run, written by
 * `enqueueAssessment` and read back by `loadAssessmentContext`.
 * `watermark` = ISO start time of the last fully applied assessment
 * (completed or awaiting_approval) for (grant, org) — see
 * `lastAssessmentWatermark` — null when there is none.
 */
export type WispAssessmentTriggerRef = {
  grantId: string;
  grantRevisionId: string;
  reason: AssessmentReason;
  watermark: string | null;
};

/**
 * What changed in the run's org since the watermark. Each list holds at most
 * 25 rows, newest first; every free-text field has been through
 * `sanitizeSweepText`. ISO strings for every timestamp.
 */
export type AssessmentDigest = {
  alerts: { id: string; title: string; severity: string; status: string; at: string }[];
  tickets: { id: string; number: string | null; title: string; status: string; updatedAt: string }[];
  incidents: { id: string; sourceKind: string; condition: string; openedAt: string }[];
  runs: { id: string; profile: string; status: string; summary: string | null }[];
  intents: { id: string; toolName: string; status: string }[];
};

/** One watch kind's serviceability for an org (Task 15, w00 A33). */
export type ReadinessCheck = { watchKind: WatchKind; serviceable: boolean; reason: string | null };
export type OrgReadiness = { orgId: string; orgName: string; checks: ReadinessCheck[]; missingIntegrations: string[] };

/**
 * The assessment-only slice of `RunContext` (`RunContext.assessment`; null
 * for every other profile and for an assessment whose grant is no longer
 * active).
 */
export interface AssessmentRunContext {
  grantId: string;
  grantRevisionId: string;
  /** The grantor — the one person an assessment's nudges go to (w00 A3). */
  grantorUserId: string;
  threadId: string;
  /** `seedContextForSession` output (already memory-wrapped; the prompt wraps it again). */
  threadSummary: string;
  /** Live concerns of the run's org under this grant's ceiling, each with the grant's `recipient` state. */
  openConcerns: Concern[];
  /** ISO lower bound of the digest window (watermark, or now − 24 h). */
  changedSince: string | null;
  digest: AssessmentDigest;
  /** Set when the run was requested by a watch (`reason.kind === 'watch'`) and the watch still exists. */
  watch: Watch | null;
  reason: AssessmentReason;
  /** The run org's readiness inventory (Task 15); null when it could not be read. */
  readiness: OrgReadiness | null;
  /**
   * The grantor's last ≤ 20 `preference` blocks keyed `nudge_feedback:*`
   * (w00 A34), one rendered line each — untrusted text, the prompt wraps it.
   */
  nudgeFeedback: string[];
}
