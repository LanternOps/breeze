/**
 * AI Scorecard W04 (#5761, refs #4182) — the **measured** impact band that sits
 * beside P2-6's estimated one on `/ai-agents/impact`.
 *
 * Everything here describes a **correlational** comparison: AI-touched work versus
 * untouched work *of the same kind, in the same window*. It is deliberately NOT a
 * before/after comparison and never a causal claim — the AI generally reaches the
 * easier items first, and that selection bias is named in the UI copy rather than
 * adjusted away. Do not rename these fields toward "saved", "impact of" or
 * "improvement": the honesty of the band lives in its vocabulary.
 *
 * Cohorts are formed by **exposure time, not linkage** (see
 * `apps/api/src/services/aiAgents/impactMeasuredCohorts.ts`): an item joins the AI
 * arm only when the earliest AI contact precedes the outcome being measured.
 */

import type { AiAgentImpactWindow } from './aiAgentImpact';

/**
 * Per-arm display gate. Below this the cohort is not rendered at all: at n = 20
 * the upper decile holds about two observations, so a p90 is reported with its
 * cohort size or not at all.
 */
export const MEASURED_MIN_COHORT_N = 20;

/** Hard cap, matching `AI_AGENT_IMPACT_WINDOWS`' largest window. */
export const MEASURED_MAX_WINDOW_DAYS = 90;

/**
 * Cohort-formation age *L* for alerts. An item is only considered once it has
 * stayed open this long, and it joins the AI arm only if AI contact happened
 * within that age.
 *
 * MUST exceed `UNGROUPED_VERDICT_DELAY_MINUTES` (= 10,
 * `apps/api/src/jobs/alertVerdictScheduler.ts`): an alert must stay open and
 * uncorrelated for ten minutes before it gets its own verdict run, so an L at or
 * below that leaves the AI arm systematically empty. Pinned by a test in this
 * package and cross-checked against the real symbol in `apps/api`.
 */
export const ALERT_EXPOSURE_AGE_MINUTES = 15;

/** Outcome horizon *H* for alert resolution — "resolved within 24 h". */
export const ALERT_OUTCOME_HORIZON_HOURS = 24;

/** Cohort-formation age *L* for tickets. Same reasoning as the alert one. */
export const TICKET_EXPOSURE_AGE_MINUTES = 15;

/** Outcome horizon *H* for ticket first response — "first response within 4 h". */
export const TICKET_RESPONSE_HORIZON_HOURS = 4;

/**
 * Why a signal (or the technician-minutes arm alone) carries no numbers. Each is
 * rendered as its own explicit state — an empty band is never shown in place of
 * one of these.
 */
export const MEASURED_OMISSION_REASONS = [
  /** n < MEASURED_MIN_COHORT_N in one or both arms of every cohort. */
  'insufficient_data',
  /** The window does not contain L + H for enough items. */
  'insufficient_followup',
  /** The caller lacks the time-entry permission / partner scope. */
  'insufficient_authority',
  /** The caller's site scope is not unrestricted. */
  'site_restricted',
] as const;
export type MeasuredOmissionReason = (typeof MEASURED_OMISSION_REASONS)[number];

export interface MeasuredArm {
  n: number;
  /**
   * PRIMARY statistic: the share of the arm that reached the outcome within *H*.
   * Right-censored items count in the denominator and never as a success.
   */
  proportionWithinHorizon: number;
  /**
   * Refinement only, and labelled as such in the UI: right-censored
   * (Kaplan–Meier) quantiles. `null` when survival never reaches the quantile.
   * Uncensored resolved-only percentiles are forbidden as a headline because
   * conditioning on completion biases the two arms differently.
   */
  censoredP50Minutes: number | null;
  censoredP90Minutes: number | null;
}

export interface MeasuredCohort {
  /** Alert rule id, or `"priority|category"` for tickets. */
  key: string;
  label: string;
  aiTouched: MeasuredArm;
  untouched: MeasuredArm;
}

export interface MeasuredSignal {
  cohorts: MeasuredCohort[];
  omitted: MeasuredOmissionReason | null;
  exposureAgeMinutes: number;
  horizonHours: number;
}

export interface TechnicianMinutesArm {
  n: number;
  /**
   * Median of *recorded* minutes per ticket among tickets that have at least one
   * completed time entry. Never called "time spent": an absent entry is missing
   * information, not zero labour.
   */
  medianRecordedMinutes: number | null;
}

export interface TechnicianMinutesCohort {
  key: string;
  label: string;
  aiTouched: TechnicianMinutesArm;
  untouched: TechnicianMinutesArm;
}

/**
 * Share of each arm's tickets that carry at least one completed time entry.
 * Published beside the medians because a delta computed over 30 %-logged tickets
 * is not a delta, and the reader must be able to see that. Values are 0..1.
 */
export interface TechnicianMinutesCoverage {
  aiTouched: number;
  untouched: number;
}

export type MeasuredTechnicianMinutes =
  | { omitted: MeasuredOmissionReason }
  | {
      omitted: null;
      cohorts: TechnicianMinutesCohort[];
      loggingCoverage: TechnicianMinutesCoverage;
    };

export interface AiAgentImpactMeasuredDto {
  schemaVersion: 1;
  window: AiAgentImpactWindow;
  /** First UTC day of the window, inclusive. */
  from: string;
  /** Last **complete** UTC day, inclusive. Server-computed, never client-supplied. */
  through: string;
  alertResolution: MeasuredSignal;
  ticketFirstResponse: MeasuredSignal;
  technicianMinutes: MeasuredTechnicianMinutes;
}
