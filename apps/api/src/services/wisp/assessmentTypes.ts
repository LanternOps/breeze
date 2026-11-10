/**
 * Wisp W05b (#9917) — the assessment run's shared types. Type-only: the run
 * loop (`aiAgents/runLoopTypes.ts`, Task 6), the context loader
 * (`wisp/assessment.ts`, Task 7) and the readiness inventory
 * (`wisp/readiness.ts`, Task 15) all speak these shapes, so they live in one
 * module none of them owns and none of them imports at runtime.
 */
import type { Concern, Watch, WatchKind } from '@breeze/shared';
import type { CheckInEvidence } from './checkInTriggers';

/**
 * Why an assessment was requested (w00 "Triage engine (W05)" + A33).
 *
 * `eventId` is the bus event's own id: kept for traceability, never shown to
 * the model (no tool can look a bus event up). `alertId` / `deviceId` are the
 * event's subject, copied from its payload when they are uuids, so the run can
 * look up the alert the event is about (#10388). `anomalyIncidentId` is the
 * `metric_anomaly_incidents` row an `anomaly.incident_opened` event names
 * (payload `incidentId`, #11425). It is a separate key because
 * `integration.health_opened` also sends `incidentId`, for a
 * connection-health incident.
 *
 * `on_demand` (#10406) is a person asking for an assessment from chat
 * (`launch_specialist {kind: 'assessment'}`). It reads the org's open alerts
 * like a first look, and it is never dropped by a queued or running tick or
 * event job (wake.ts `requestAssessment` upgrades an unclaimed tick job, or
 * adds a successor job). `requestId` is the chat
 * request's id, kept for traceability and never shown to the model.
 *
 * `check_in` (W07 #11496, #10410) is a run-mode check-in firing
 * (wisp/checkInRuns.ts): the person approved, on a card, that Wisp checks on
 * its own when it fires. `instruction` is the check-in's instruction after
 * `sanitizeCheckInInstruction`; `evidence` is what the trigger's state showed
 * when it fired (an event check-in), null for a time check-in. `checkInId`
 * links the run back to its row and is never shown to the model.
 */
export type AssessmentReason =
  | {
    kind: 'event';
    eventType: string;
    eventId: string;
    alertId?: string;
    deviceId?: string;
    anomalyIncidentId?: string;
  }
  | { kind: 'tick' }
  | { kind: 'watch'; watchId: string; hits?: WatchHitSummary }
  | { kind: 'onboarding' }
  | { kind: 'on_demand'; requestId: string }
  | { kind: 'check_in'; checkInId: string; instruction: string; evidence: CheckInEvidence | null };

/**
 * #11424 — what the wake scheduler's in-code evaluation of a watch found, sent
 * with the `watch` reason so the run does not re-query it. Present only when
 * the scheduler evaluated the watch (services/wisp/watchHits.ts) and the
 * hit-set changed; absent for a kind it does not evaluate and when the
 * evaluation failed (the watch then runs anyway, as before #11424).
 *
 *   - `first`   — no earlier evaluation is stored for the watch.
 *   - `new`     — the previous evaluation found nothing; every hit is new.
 *   - `cleared` — the previous evaluation found hits; nothing matches now.
 *   - `changed` — the hit-set differs (hits added, removed or changed state).
 *
 * `ids` = up to 25 hit ids (uuids, `WATCH_HIT_SAMPLE_MAX` in watchHits.ts),
 * newest first where the kind has a timestamp (alerts, findings; patch
 * devices come in id order); `subject` names what they are. `orgId` = the org evaluated: a
 * partner-wide watch (`partnerWide`) is evaluated in its grant's round-robin
 * org only, so its previous evaluation may have covered another org and its
 * change is only ever `first` or `changed`.
 */
export type WatchHitChange = 'first' | 'new' | 'cleared' | 'changed';
export type WatchHitSubject = 'alert' | 'device' | 'finding';
export type WatchHitSummary = {
  change: WatchHitChange;
  subject: WatchHitSubject;
  orgId: string;
  partnerWide: boolean;
  count: number;
  previousCount: number | null;
  ids: string[];
};

/**
 * #11424: the hit-set a watch request was made for, carried on the assess job
 * (not in the model-facing reason) so `processAssessJob` records it on the
 * watch row only once `enqueueAssessment` has admitted a run. `previousHash`
 * is the hash the claim returned, for the compare-and-set.
 */
export type WatchHitRecord = { watchId: string; previousHash: string | null; hash: string; count: number };

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
 * 25 rows, newest first — except on a first look, where `alerts` holds the
 * org's open (active / acknowledged) alerts, worst severity first, whenever
 * they fired (#10389). Every free-text field has been through
 * `sanitizeSweepText`. ISO strings for every timestamp.
 */
export type AssessmentDigest = {
  /** Triggered or resolved since the watermark; `at` = the later of triggered / resolved. */
  alerts: { id: string; title: string; severity: string; status: string; at: string }[];
  tickets: { id: string; number: string | null; title: string; status: string; updatedAt: string }[];
  incidents: { id: string; sourceKind: string; condition: string; openedAt: string }[];
  runs: { id: string; profile: string; status: string; summary: string | null }[];
  intents: { id: string; toolName: string; status: string }[];
  /**
   * #11425: metric anomaly incidents (`metric_anomaly_incidents`). This is
   * current state, not a since-watermark change: the org's open incidents
   * (announced, not suppressed by their episode, episode still open) plus the
   * one that triggered the run, whatever its status. The trigger comes first,
   * then the most recently seen. `openedAt` is the incident's `first_seen_at`.
   * `status` is its episode's status (`open` | `resolved` | `dismissed`), or
   * `unknown` when the incident has no episode row. `peakScore` is the
   * detector's raw score: an unbounded magnitude, not 0–1.
   *
   * null = not read: the grantor lacks `devices:read`, or the read failed
   * (reported to Sentry). That is distinct from `[]` (read, none open).
   */
  anomalies: {
    id: string;
    deviceId: string;
    deviceName: string | null;
    anomalyType: string;
    metricNames: string[];
    peakScore: number;
    openedAt: string;
    status: string;
  }[] | null;
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
  /**
   * #10389: no earlier assessment for (grant, org) — no watermark, or an
   * onboarding reason. The digest's alerts are then the org's OPEN alerts
   * (no time bound) instead of those triggered since `changedSince`, and the
   * prompt frames the run as a look at the current state.
   */
  firstLook: boolean;
  /**
   * No fully applied earlier assessment of (grant, org): the run's watermark
   * is null. Narrower than `firstLook`, which an onboarding or on-demand
   * reason also sets. The finalizer reads it so that an on-demand run that is
   * the org's first look creates the readiness note, as onboarding does
   * (#10406 × #11429).
   */
  noEarlierAssessment: boolean;
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
