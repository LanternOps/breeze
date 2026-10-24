/**
 * Wisp triage engine (W05, feature #9906): the closed value sets of
 * `wisp_concerns`, `wisp_concern_recipients` and `wisp_watches`, and the DTOs
 * the `/api/v1/wisp/concerns` + `/api/v1/wisp/watches` routes return.
 *
 * Each array mirrors a CHECK constraint in
 * apps/api/migrations/2027-01-04-110300-wisp-concerns-watches.sql — change
 * both together.
 */

/**
 * What a concern is about. `subject_id` is a soft reference (no FK): subjects
 * span tables with different erasure dispositions, and the retention reaper
 * resolves a concern whose subject is gone with outcome `subject_gone`.
 * `incident` (w00 A30) is minted by the ticket-cluster poller / correlator and
 * names the concern itself; `quote`/`invoice`/`contract`/`site` are w00 A35.
 */
export const CONCERN_SUBJECT_KINDS = [
  'ticket',
  'device',
  'alert',
  'org',
  'integration',
  'run',
  'task',
  'incident',
  'quote',
  'invoice',
  'contract',
  'site',
] as const;
export type ConcernSubjectKind = (typeof CONCERN_SUBJECT_KINDS)[number];
export type ConcernSubject = { kind: ConcernSubjectKind; id: string };

/**
 * Subject kinds a person may raise from a chat turn (`raise_concern`, w00 A25
 * + A35). Each is verified to belong to the named org through its own
 * org-scoped read. `incident` is correlator-only; the rest stay run-only.
 */
export const CHAT_RAISE_CONCERN_SUBJECT_KINDS = [
  'ticket',
  'org',
  'quote',
  'invoice',
  'contract',
  'device',
] as const satisfies readonly ConcernSubjectKind[];
export type ChatRaiseConcernSubjectKind = (typeof CHAT_RAISE_CONCERN_SUBJECT_KINDS)[number];

/** Ordered low → high; list endpoints sort high first. */
export const CONCERN_SEVERITIES = ['info', 'low', 'medium', 'high'] as const;
export type ConcernSeverity = (typeof CONCERN_SEVERITIES)[number];

/** `open` and `snoozed` are "live": at most one live concern per subject (and per signature). */
export const CONCERN_STATUSES = ['open', 'snoozed', 'resolved', 'dismissed'] as const;
export type ConcernStatus = (typeof CONCERN_STATUSES)[number];
export const LIVE_CONCERN_STATUSES = ['open', 'snoozed'] as const satisfies readonly ConcernStatus[];

/** One tap "useful / not useful" on a nudged concern (w00 A34). */
export const CONCERN_FEEDBACK_VALUES = ['useful', 'not_useful'] as const;
export type ConcernFeedback = (typeof CONCERN_FEEDBACK_VALUES)[number];

/** `ticket_cluster` (w00 A30) is evaluated deterministically by the ticket-cluster poller. */
export const WATCH_KINDS = [
  'ticket_waiting',
  'alert_pattern',
  'backup_health',
  'patch_compliance',
  'security_findings',
  'custom_query',
  'ticket_cluster',
] as const;
export type WatchKind = (typeof WATCH_KINDS)[number];

export const WATCH_STATUSES = ['active', 'stopped'] as const;
export type WatchStatus = (typeof WATCH_STATUSES)[number];

/** Watch cadence bounds (minutes) — the `wisp_watches.cadence_minutes` CHECK. */
export const WATCH_CADENCE_MIN_MINUTES = 15;
export const WATCH_CADENCE_MAX_MINUTES = 10_080;

/** Field caps — the CHECK constraints on `wisp_concerns` / `wisp_concern_recipients`. */
export const CONCERN_SUMMARY_MAX = 2000;
export const CONCERN_OUTCOME_MAX = 1000;
export const CONCERN_FEEDBACK_NOTE_MAX = 200;
export const CONCERN_EVIDENCE_MAX_KEYS = 20;
/**
 * JSON-text byte caps checked by Zod so an oversized payload is a 400, not a
 * CHECK violation. Deliberately half the DB caps (`pg_column_size(evidence)
 * <= 32768`, `pg_column_size(params) <= 8192`): jsonb storage size is not the
 * JSON text length, so the API stays well inside the column CHECK.
 */
export const CONCERN_EVIDENCE_MAX_BYTES = 16_384;
export const WATCH_PARAMS_MAX_KEYS = 20;
export const WATCH_PARAMS_MAX_BYTES = 4_096;
/** A snooze may run at most this far ahead. */
export const CONCERN_SNOOZE_MAX_DAYS = 30;

/** The caller grant's per-recipient state, joined onto a concern. */
export interface ConcernRecipientState {
  nudgeCount: number;
  lastNudgedAt: string | null;
  nextEligibleNudgeAt: string | null;
  snoozedUntil: string | null;
  dismissedAt: string | null;
  answeredAt: string | null;
  /** ≥ 2 nudges since the last answer: the concern rides the digest only (spec §7.4). */
  digestOnly: boolean;
  feedback: ConcernFeedback | null;
}

export interface Concern {
  id: string;
  partnerId: string;
  /** null = a partner-level concern (cross-customer incident, w00 A30); visible to partner-wide grants only. */
  orgId: string | null;
  subject: ConcernSubject;
  summary: string;
  severity: ConcernSeverity;
  status: ConcernStatus;
  evidence: Record<string, unknown>;
  outcome: string | null;
  /** Correlator idempotency key; null for subject-keyed concerns. */
  signature: string | null;
  /** Partner-level incidents only: the org-level concerns it groups. */
  childConcernIds: string[];
  /**
   * Latest intent minted by `propose_action({ concernId })`, read from
   * `evidence.approvalIntentId`; W06's web page and mobile sheet open the
   * approval card from it.
   */
  approvalIntentId: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  recipient?: ConcernRecipientState;
}

export interface Watch {
  id: string;
  partnerId: string;
  /** null = every org in the grant's ceiling (partner-wide grants only). */
  orgId: string | null;
  grantId: string;
  kind: WatchKind;
  params: Record<string, unknown>;
  cadenceMinutes: number;
  status: WatchStatus;
  stoppedReason: string | null;
  lastRanAt: string | null;
  nextDueAt: string;
  createdAt: string;
}
