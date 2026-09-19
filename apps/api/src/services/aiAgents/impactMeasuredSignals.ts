/**
 * AI Scorecard W04 (#5761, refs #4182) — the loaders that turn the cohort SQL in
 * `impactMeasuredCohorts.ts` into the DTO's three signals.
 *
 * Kaplan–Meier is computed in TypeScript (`impactStatistics.ts`), never in SQL:
 * the arithmetic belongs in a fast unit test with hand-computed expectations,
 * not inside seed-data noise.
 *
 * Every read runs under the CALLER's request DB context and carries
 * `auth.orgCondition(...)` on top of RLS, because partner scope means ACCESSIBLE
 * orgs, not automatically every org under the partner.
 */

import type { SQL } from 'drizzle-orm';

import {
  ALERT_EXPOSURE_AGE_MINUTES,
  ALERT_OUTCOME_HORIZON_HOURS,
  MEASURED_MAX_WINDOW_DAYS,
  MEASURED_MIN_COHORT_N,
  TICKET_EXPOSURE_AGE_MINUTES,
  TICKET_RESPONSE_HORIZON_HOURS,
  type MeasuredCohort,
  type MeasuredSignal,
  type TechnicianMinutesCohort,
  type TechnicianMinutesCoverage,
} from '@breeze/shared';

import { db } from '../../db';
import { alerts } from '../../db/schema/alerts';
import { tickets } from '../../db/schema/portal';
import type { AuthContext } from '../../middleware/auth';
import {
  alertCohortQuery,
  ticketCohortQuery,
  ticketRecordedMinutesQuery,
} from './impactMeasuredCohorts';
import { buildArm, median, type Observation } from './impactStatistics';

/** The resolved read window: the orgs in scope and the inclusive UTC day bounds. */
export interface MeasuredWindow {
  orgIds: readonly string[];
  from: string;
  through: string;
  /** The requested window length in days, used to pick the right omission reason (#5879). */
  windowDays: number;
}

interface CohortRow {
  key: string;
  label: string;
  aiTouched: boolean;
  observed: boolean;
  minutes: number;
  hasFollowup: boolean;
}

/**
 * Postgres returns numerics as strings through postgres.js, so a cast is needed
 * — but a value that will not parse is an ANOMALY, not a zero.
 *
 * Substituting 0 here would feed a fabricated 0-minute resolution into the
 * Kaplan-Meier curve or a fabricated 0-minute labour entry into the median, and
 * nobody downstream could tell. This band's whole purpose is to be trustworthy,
 * so an unparseable value fails loudly (a visible 500) rather than quietly
 * dragging an arm toward "faster".
 */
function toNumber(value: unknown, column: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(
      `[impactMeasured] non-numeric value for "${column}" (${typeof value}) — refusing to substitute 0`,
    );
  }
  return n;
}

function toBoolean(value: unknown): boolean {
  return value === true || value === 't' || value === 'true';
}

/**
 * Run a cohort query.
 *
 * A non-array result is a driver/shape fault, and returning `[]` for it would
 * surface as `omitted: 'insufficient_data'` — telling a partner their AI did
 * nothing when in truth the query never produced rows. Throw instead, so the
 * failure reaches the route's error path where it is visible. (Same fail-loud
 * shape as `ticketContext.ts`'s raw-SQL helper.)
 */
async function executeRows(fragment: SQL): Promise<Record<string, unknown>[]> {
  const rows = (await db.execute(fragment)) as unknown;
  if (!Array.isArray(rows)) {
    throw new Error(
      `[impactMeasured] cohort query returned a non-array result (${typeof rows}) — refusing to report it as "no data"`,
    );
  }
  return rows as Record<string, unknown>[];
}

/**
 * Fold cohort rows into per-key arms, applying the display gate.
 *
 * A cohort survives only when BOTH arms clear `MEASURED_MIN_COHORT_N` — a
 * one-sided comparison is not a comparison. Rows without enough follow-up for
 * the horizon are dropped here rather than counted as failures.
 */
function foldCohorts(rows: readonly CohortRow[], horizonMinutes: number): {
  cohorts: MeasuredCohort[];
  eligibleRows: number;
  followupRows: number;
} {
  const byKey = new Map<string, { label: string; ai: Observation[]; untouched: Observation[] }>();

  let followupRows = 0;
  for (const row of rows) {
    if (!row.hasFollowup) continue;
    followupRows += 1;
    let bucket = byKey.get(row.key);
    if (!bucket) {
      bucket = { label: row.label, ai: [], untouched: [] };
      byKey.set(row.key, bucket);
    }
    const observation: Observation = { minutes: row.minutes, observed: row.observed };
    if (row.aiTouched) bucket.ai.push(observation);
    else bucket.untouched.push(observation);
  }

  const cohorts: MeasuredCohort[] = [];
  for (const [key, bucket] of byKey) {
    const aiTouched = buildArm(bucket.ai, horizonMinutes);
    const untouched = buildArm(bucket.untouched, horizonMinutes);
    // Both arms or neither: a cohort rendered with one arm below the gate would
    // invite the reader to compare a solid number against a noisy one.
    if (!aiTouched || !untouched) continue;
    cohorts.push({ key, label: bucket.label, aiTouched, untouched });
  }
  cohorts.sort((a, b) => b.aiTouched.n + b.untouched.n - (a.aiTouched.n + a.untouched.n));

  return { cohorts, eligibleRows: rows.length, followupRows };
}

/**
 * Distinguish "nothing happened in this window" from "the window is too short to
 * answer the question". Both produce an empty band, and conflating them would
 * tell a partner their AI did nothing when the real answer is "ask again later".
 *
 * `insufficient_followup` renders as "Try a longer window" (#5879) — advice with
 * nowhere to go once the caller is already AT the longest window Breeze offers.
 * At `MEASURED_MAX_WINDOW_DAYS` there is no longer window to try, so that shape
 * collapses to `insufficient_data`: still honest (there genuinely isn't enough
 * data), but it doesn't send the reader chasing a control that doesn't exist.
 */
function signalFrom(
  folded: ReturnType<typeof foldCohorts>,
  exposureAgeMinutes: number,
  horizonHours: number,
  windowDays: number,
): MeasuredSignal {
  if (folded.cohorts.length > 0) {
    return { cohorts: folded.cohorts, omitted: null, exposureAgeMinutes, horizonHours };
  }
  const wouldSuggestLongerWindow =
    folded.eligibleRows > 0 && folded.followupRows < MEASURED_MIN_COHORT_N * 2;
  const omitted = wouldSuggestLongerWindow && windowDays < MEASURED_MAX_WINDOW_DAYS
    ? 'insufficient_followup'
    : 'insufficient_data';
  return { cohorts: [], omitted, exposureAgeMinutes, horizonHours };
}

/**
 * Alert resolution, keyed by `alerts.rule_id`.
 *
 * Cohorts are formed WITHIN one rule: comparing all AI-touched alerts to all
 * untouched ones would measure which alerts the AI *chose*, not what happened
 * after it looked.
 */
export async function loadAlertResolutionSignal(
  auth: AuthContext,
  window: MeasuredWindow,
): Promise<MeasuredSignal> {
  const horizonMinutes = ALERT_OUTCOME_HORIZON_HOURS * 60;
  if (window.orgIds.length === 0) {
    return { cohorts: [], omitted: 'insufficient_data', exposureAgeMinutes: ALERT_EXPOSURE_AGE_MINUTES, horizonHours: ALERT_OUTCOME_HORIZON_HOURS };
  }

  const raw = await executeRows(
    alertCohortQuery(window.orgIds, window.from, window.through, auth.orgCondition(alerts.orgId)),
  );
  const rows: CohortRow[] = raw.map((row) => {
    const ruleId = String(row.rule_id ?? '');
    return {
      key: ruleId,
      // The KEY is the rule id (stable); the LABEL is the rule's name, falling
      // back to the id when the rule row has since been deleted.
      label: typeof row.rule_name === 'string' && row.rule_name.length > 0 ? row.rule_name : ruleId,
      aiTouched: toBoolean(row.ai_touched),
      observed: toBoolean(row.observed),
      minutes: toNumber(row.minutes, 'minutes'),
      hasFollowup: toBoolean(row.has_followup),
    };
  });

  return signalFrom(
    foldCohorts(rows, horizonMinutes),
    ALERT_EXPOSURE_AGE_MINUTES,
    ALERT_OUTCOME_HORIZON_HOURS,
    window.windowDays,
  );
}

/** Ticket first response, keyed by `priority || '|' || category`. */
export async function loadTicketFirstResponseSignal(
  auth: AuthContext,
  window: MeasuredWindow,
): Promise<MeasuredSignal> {
  const horizonMinutes = TICKET_RESPONSE_HORIZON_HOURS * 60;
  if (window.orgIds.length === 0) {
    return { cohorts: [], omitted: 'insufficient_data', exposureAgeMinutes: TICKET_EXPOSURE_AGE_MINUTES, horizonHours: TICKET_RESPONSE_HORIZON_HOURS };
  }

  const raw = await executeRows(
    ticketCohortQuery(window.orgIds, window.from, window.through, auth.orgCondition(tickets.orgId)),
  );
  const rows: CohortRow[] = raw.map((row) => {
    const priority = String(row.priority ?? '');
    const category = String(row.category ?? '');
    return {
      key: `${priority}|${category}`,
      label: category.length > 0 ? `${priority} · ${category}` : priority,
      aiTouched: toBoolean(row.ai_touched),
      observed: toBoolean(row.observed),
      minutes: toNumber(row.minutes, 'minutes'),
      hasFollowup: toBoolean(row.has_followup),
    };
  });

  return signalFrom(
    foldCohorts(rows, horizonMinutes),
    TICKET_EXPOSURE_AGE_MINUTES,
    TICKET_RESPONSE_HORIZON_HOURS,
    window.windowDays,
  );
}

export interface TechnicianMinutesResult {
  cohorts: TechnicianMinutesCohort[];
  loggingCoverage: TechnicianMinutesCoverage;
}

/**
 * Median *recorded* technician minutes per ticket, per cohort, plus the share of
 * each arm that carries any recorded minutes at all.
 *
 * The coverage number is not decoration: a median computed over 30 %-logged
 * tickets is not a median of the labour, and the reader must be able to see
 * that. Unlogged tickets are excluded from the median and counted in coverage —
 * an absent entry is missing information, not zero labour.
 */
export async function loadTechnicianMinutes(
  auth: AuthContext,
  window: MeasuredWindow,
): Promise<TechnicianMinutesResult> {
  if (window.orgIds.length === 0) {
    return { cohorts: [], loggingCoverage: { aiTouched: 0, untouched: 0 } };
  }

  const raw = await executeRows(
    ticketRecordedMinutesQuery(window.orgIds, window.from, window.through, auth.orgCondition(tickets.orgId)),
  );

  const byKey = new Map<string, { label: string; ai: number[]; untouched: number[] }>();
  const totals = { aiTouched: 0, untouched: 0 };
  const logged = { aiTouched: 0, untouched: 0 };

  for (const row of raw) {
    const priority = String(row.priority ?? '');
    const category = String(row.category ?? '');
    const key = `${priority}|${category}`;
    const label = category.length > 0 ? `${priority} · ${category}` : priority;
    const aiTouched = toBoolean(row.ai_touched);
    // NULL (no completed entry at all) is distinct from 0: SUM over zero rows is
    // NULL, and that ticket is unlogged, not a ticket that took no time.
    const hasRecord = row.recorded_minutes !== null && row.recorded_minutes !== undefined;

    if (aiTouched) totals.aiTouched += 1;
    else totals.untouched += 1;
    if (!hasRecord) continue;
    if (aiTouched) logged.aiTouched += 1;
    else logged.untouched += 1;

    let bucket = byKey.get(key);
    if (!bucket) {
      bucket = { label, ai: [], untouched: [] };
      byKey.set(key, bucket);
    }
    (aiTouched ? bucket.ai : bucket.untouched).push(toNumber(row.recorded_minutes, 'recorded_minutes'));
  }

  const cohorts: TechnicianMinutesCohort[] = [];
  for (const [key, bucket] of byKey) {
    if (bucket.ai.length < MEASURED_MIN_COHORT_N || bucket.untouched.length < MEASURED_MIN_COHORT_N) continue;
    cohorts.push({
      key,
      label: bucket.label,
      aiTouched: { n: bucket.ai.length, medianRecordedMinutes: median(bucket.ai) },
      untouched: { n: bucket.untouched.length, medianRecordedMinutes: median(bucket.untouched) },
    });
  }
  cohorts.sort((a, b) => b.aiTouched.n + b.untouched.n - (a.aiTouched.n + a.untouched.n));

  return {
    cohorts,
    loggingCoverage: {
      aiTouched: totals.aiTouched === 0 ? 0 : logged.aiTouched / totals.aiTouched,
      untouched: totals.untouched === 0 ? 0 : logged.untouched / totals.untouched,
    },
  };
}
