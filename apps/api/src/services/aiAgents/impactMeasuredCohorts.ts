/**
 * AI Scorecard W04 (#5761, refs #4182) — the cohort SQL behind the MEASURED
 * impact band.
 *
 * ## Cohorts are formed by EXPOSURE TIME, not by linkage
 *
 * Three defects, all verified on `main`, are the reason this file is not a
 * simple `JOIN ai_agent_runs ON run.alert_id = alert.id`. **Do not "simplify" it
 * back into one.**
 *
 * 1. **Reverse temporal attribution.** `jobs/alertVerdictScheduler.ts` sets
 *    `UNGROUPED_VERDICT_DELAY_MINUTES = 10`: an alert must stay open and
 *    uncorrelated for ten minutes before it gets its own verdict run. So an
 *    alert that self-resolves in five minutes and is *then* analysed would enter
 *    a linkage-based "AI-touched" cohort with a five-minute MTTR — the AI
 *    credited for an outcome that completed before it looked. Identically on
 *    tickets: `services/aiAgents/ticketHelpdeskSubscriber.ts` returns unless
 *    `toStatus === 'resolved'`, so an `ai_agent_runs.ticket_id` link is **no
 *    evidence** of involvement before first response.
 * 2. **Group verdicts are invisible to a direct link.** Correlation-group
 *    verdicts carry `alert_id = NULL` by design
 *    (`services/aiAgents/alertVerdicts.ts`), so a `WHERE v.alert_id = a.id`
 *    predicate silently drops them. Membership lives in
 *    `alert_correlation_members`.
 * 3. **Resolved-only percentiles omit still-open cases** and bias the two arms
 *    differently. Every cohort row therefore carries an `observed` flag and the
 *    statistics module censors rather than drops.
 *
 * ## The timestamp trap
 *
 * `alerts.triggered_at` / `resolved_at` and every `tickets` date column are
 * plain `timestamp` **without** time zone. `ai_alert_verdicts.created_at`,
 * `ai_agent_runs.started_at` and `ticket_drafts.created_at` **are**
 * `timestamptz`. P2-6's SQL operates on `timestamptz` and casts with
 * `AT TIME ZONE 'UTC'`; copying that blindly onto a naive column shifts the
 * bound by twice the session offset.
 *
 * **Rule:** bound a naive column with `>= <day>::date::timestamp` /
 * `< (<day>::date + 1)::timestamp` and **no** `AT TIME ZONE`; convert a
 * `timestamptz` to the comparable naive UTC instant with `(x AT TIME ZONE 'UTC')`
 * before comparing it to a naive column.
 *
 * ## No bounds CTE
 *
 * Every window bound is inlined at each predicate. A `bounds` CTE referenced by
 * sibling CTEs is materialized, the range predicates stop being constant-folded,
 * and the index range scans this wave's migration adds are lost.
 */

import { inArray, sql, type SQL } from 'drizzle-orm';

import {
  ALERT_EXPOSURE_AGE_MINUTES,
  ALERT_OUTCOME_HORIZON_HOURS,
  TICKET_EXPOSURE_AGE_MINUTES,
  TICKET_RESPONSE_HORIZON_HOURS,
} from '@breeze/shared';

import { alertCorrelationMembers, alertRules, alerts } from '../../db/schema/alerts';
import { aiAgentRuns } from '../../db/schema/aiAgents';
import { aiAlertVerdicts } from '../../db/schema/aiAlertVerdicts';
import { tickets } from '../../db/schema/portal';
import { ticketDrafts } from '../../db/schema/ticketDrafts';
import { timeEntries } from '../../db/schema/timeTracking';

/** `>= <day> 00:00` on a NAIVE (no time zone) column. */
const naiveDayStart = (day: string): SQL => sql`(${day}::date)::timestamp`;
/** `< <day> + 1 day 00:00` on a NAIVE column — the window's exclusive upper bound. */
const naiveDayEndExclusive = (day: string): SQL => sql`((${day}::date + 1))::timestamp`;

/**
 * The earliest AI contact per alert, deduplicated across the three paths.
 *
 * Contacts are bounded to the alert window widened by the exposure age, so this
 * never degenerates into an unbounded scan of every verdict and run in the org —
 * an exposure later than `triggered_at + L` cannot put an alert in the AI arm
 * anyway.
 *
 * @param orgIds  The orgs the caller may read. Never empty — the caller resolves
 *                this from `auth.accessibleOrgIds` / the requested `orgId`.
 */
export function alertExposureCte(orgIds: readonly string[], from: string, through: string): SQL {
  const contactFrom = sql`${naiveDayStart(from)}`;
  // An alert triggered on the last day of the window can still be exposed up to
  // L minutes after midnight of the following day.
  const contactThrough = sql`(${naiveDayEndExclusive(through)} + make_interval(mins => ${ALERT_EXPOSURE_AGE_MINUTES}))`;

  return sql`
    SELECT contact.alert_id AS alert_id, MIN(contact.exposure_at) AS exposure_at
    FROM (
      -- (a) a verdict written directly against this alert
      SELECT ${aiAlertVerdicts.alertId} AS alert_id,
             (${aiAlertVerdicts.createdAt} AT TIME ZONE 'UTC') AS exposure_at
      FROM ${aiAlertVerdicts}
      WHERE ${inArray(aiAlertVerdicts.orgId, [...orgIds])}
        AND ${aiAlertVerdicts.alertId} IS NOT NULL
        AND (${aiAlertVerdicts.createdAt} AT TIME ZONE 'UTC') >= ${contactFrom}
        AND (${aiAlertVerdicts.createdAt} AT TIME ZONE 'UTC') < ${contactThrough}
      UNION ALL
      -- (b) a CORRELATION-GROUP verdict. These carry alert_id = NULL by design,
      -- so the direct branch above can never see them; membership is the join.
      SELECT ${alertCorrelationMembers.alertId} AS alert_id,
             (${aiAlertVerdicts.createdAt} AT TIME ZONE 'UTC') AS exposure_at
      FROM ${aiAlertVerdicts}
      JOIN ${alertCorrelationMembers}
        ON ${alertCorrelationMembers.groupId} = ${aiAlertVerdicts.correlationGroupId}
       AND ${alertCorrelationMembers.orgId} = ${aiAlertVerdicts.orgId}
      WHERE ${inArray(aiAlertVerdicts.orgId, [...orgIds])}
        AND ${aiAlertVerdicts.correlationGroupId} IS NOT NULL
        AND (${aiAlertVerdicts.createdAt} AT TIME ZONE 'UTC') >= ${contactFrom}
        AND (${aiAlertVerdicts.createdAt} AT TIME ZONE 'UTC') < ${contactThrough}
      UNION ALL
      -- (c) an agent run attached to this alert. ai_agent_runs has NO
      -- created_at; started_at is the exposure instant. A run that never started
      -- is NOT exposure — the AI never looked at the alert — so queued_at is
      -- deliberately not used as a fallback.
      SELECT ${aiAgentRuns.alertId} AS alert_id,
             (${aiAgentRuns.startedAt} AT TIME ZONE 'UTC') AS exposure_at
      FROM ${aiAgentRuns}
      WHERE ${inArray(aiAgentRuns.orgId, [...orgIds])}
        AND ${aiAgentRuns.alertId} IS NOT NULL
        AND ${aiAgentRuns.startedAt} IS NOT NULL
        AND (${aiAgentRuns.startedAt} AT TIME ZONE 'UTC') >= ${contactFrom}
        AND (${aiAgentRuns.startedAt} AT TIME ZONE 'UTC') < ${contactThrough}
    ) AS contact
    GROUP BY contact.alert_id
  `;
}

/**
 * The alert-resolution cohort: one row per eligible alert, with the arm it falls
 * into and the observation the statistics module consumes.
 *
 * Cohort membership (BOTH arms): the alert was still open at the exposure age L.
 * An alert that closed before L never had a chance to be exposed, so including
 * it would load the untouched arm with trivially-fast items.
 *
 * Outcome minutes are measured from `triggered_at + L`, the instant both arms
 * enter the cohort — not from `triggered_at`, which would hand the untouched arm
 * a free L-minute head start.
 *
 * `alerts.status` is ('active','acknowledged','resolved','suppressed','dismissed').
 * **`resolved` is the ONLY status that counts as an outcome.** Counting a
 * suppression or a dismissal would make noise suppression look like fixing
 * things.
 *
 * A suppressed or dismissed alert is therefore right-censored at the window
 * bound — **not** at `suppressed_until` / `dismissed_at`, deliberately:
 *
 *  - The PRIMARY statistic is unaffected either way. `proportionWithinHorizon`
 *    counts only `observed` outcomes, and a dismissal is never `observed`, so
 *    the choice of censoring instant cannot move it.
 *  - For the Kaplan–Meier refinement, censoring at the dismissal instant would
 *    be **informative censoring** — the reason for leaving the risk set is
 *    correlated with the outcome — which is precisely the assumption KM needs
 *    and would bias survival upward. Censoring at the window bound states what
 *    is actually known: this alert did not reach resolution for that long.
 *
 * Pinned by `alertCohortQuery`'s case in `impactMeasured.contract.test.ts` and
 * by the suppressed-alert case in `impactMeasuredSignals.integration.test.ts`.
 *
 * @param orgCondition The caller's `auth.orgCondition(alerts.orgId)`, applied on
 *        top of RLS and on top of `orgIds`: partner scope means ACCESSIBLE orgs,
 *        not automatically every org under the partner.
 */
export function alertCohortQuery(
  orgIds: readonly string[],
  from: string,
  through: string,
  orgCondition: SQL | undefined,
): SQL {
  const windowStart = naiveDayStart(from);
  const windowEnd = naiveDayEndExclusive(through);
  const exposureAge = sql`make_interval(mins => ${ALERT_EXPOSURE_AGE_MINUTES})`;
  const horizon = sql`make_interval(hours => ${ALERT_OUTCOME_HORIZON_HOURS})`;
  const entry = sql`(${alerts.triggeredAt} + ${exposureAge})`;
  // The censoring instant: the earlier of the window's end and now. Never the
  // future — an item cannot be known not to have resolved after the last moment
  // we observed it.
  const censorAt = sql`LEAST(${windowEnd}, (now() AT TIME ZONE 'UTC'))`;
  // `resolved` is the ONLY status that counts as an outcome.
  const resolvedObserved = sql`(
    ${alerts.status} = 'resolved'
    AND ${alerts.resolvedAt} IS NOT NULL
    AND ${alerts.resolvedAt} < ${windowEnd}
  )`;

  return sql`
    WITH exposure AS (${alertExposureCte(orgIds, from, through)})
    SELECT
      ${alerts.id} AS alert_id,
      ${alerts.orgId} AS org_id,
      ${alerts.ruleId} AS rule_id,
      ${alertRules.name} AS rule_name,
      exposure.exposure_at AS exposure_at,
      (exposure.exposure_at IS NOT NULL AND exposure.exposure_at <= ${entry}) AS ai_touched,
      ${resolvedObserved} AS observed,
      GREATEST(
        0,
        EXTRACT(EPOCH FROM (
          CASE WHEN ${resolvedObserved} THEN ${alerts.resolvedAt} ELSE ${censorAt} END
          - ${entry}
        )) / 60.0
      ) AS minutes,
      -- Enough follow-up for the horizon to be answerable at all.
      (${entry} + ${horizon} <= ${windowEnd}) AS has_followup
    FROM ${alerts}
    LEFT JOIN exposure ON exposure.alert_id = ${alerts.id}
    -- Only for the human-readable cohort label; the cohort KEY is the rule id.
    LEFT JOIN ${alertRules} ON ${alertRules.id} = ${alerts.ruleId}
    WHERE ${inArray(alerts.orgId, [...orgIds])}
      ${orgCondition ? sql`AND ${orgCondition}` : sql``}
      AND ${alerts.ruleId} IS NOT NULL
      -- NAIVE columns: no AT TIME ZONE here, and the casts are inlined rather
      -- than hoisted into a bounds CTE (see the module header).
      AND ${alerts.triggeredAt} >= ${windowStart}
      AND ${alerts.triggeredAt} < ${windowEnd}
      -- Cohort membership: still open at the exposure age, in BOTH arms.
      AND (${alerts.resolvedAt} IS NULL OR ${alerts.resolvedAt} >= ${entry})
  `;
}

/**
 * The earliest AI contact per ticket: the first *started* agent run attached to
 * it, or the first AI draft written for it.
 *
 * The run linkage alone is famously not evidence of pre-first-response
 * involvement (`ticketHelpdeskSubscriber` fires on `toStatus === 'resolved'`),
 * which is exactly why the caller compares this instant against
 * `created_at + L` rather than treating any link as membership.
 */
export function ticketExposureCte(orgIds: readonly string[], from: string, through: string): SQL {
  const contactFrom = naiveDayStart(from);
  const contactThrough = sql`(${naiveDayEndExclusive(through)} + make_interval(mins => ${TICKET_EXPOSURE_AGE_MINUTES}))`;

  return sql`
    SELECT contact.ticket_id AS ticket_id, MIN(contact.exposure_at) AS exposure_at
    FROM (
      SELECT ${aiAgentRuns.ticketId} AS ticket_id,
             (${aiAgentRuns.startedAt} AT TIME ZONE 'UTC') AS exposure_at
      FROM ${aiAgentRuns}
      WHERE ${inArray(aiAgentRuns.orgId, [...orgIds])}
        AND ${aiAgentRuns.ticketId} IS NOT NULL
        AND ${aiAgentRuns.startedAt} IS NOT NULL
        AND (${aiAgentRuns.startedAt} AT TIME ZONE 'UTC') >= ${contactFrom}
        AND (${aiAgentRuns.startedAt} AT TIME ZONE 'UTC') < ${contactThrough}
      UNION ALL
      SELECT ${ticketDrafts.ticketId} AS ticket_id,
             (${ticketDrafts.createdAt} AT TIME ZONE 'UTC') AS exposure_at
      FROM ${ticketDrafts}
      WHERE ${inArray(ticketDrafts.orgId, [...orgIds])}
        AND (${ticketDrafts.createdAt} AT TIME ZONE 'UTC') >= ${contactFrom}
        AND (${ticketDrafts.createdAt} AT TIME ZONE 'UTC') < ${contactThrough}
    ) AS contact
    GROUP BY contact.ticket_id
  `;
}

/**
 * The ticket-first-response cohort. Cohort key is `priority || '|' || category`.
 *
 * Soft-deleted tickets are excluded: `deleted_at` is a live filter on every
 * staff/portal list, stats count and by-id mutation, and `tickets_deleted_at_idx`
 * exists precisely for it.
 */
export function ticketCohortQuery(
  orgIds: readonly string[],
  from: string,
  through: string,
  orgCondition: SQL | undefined,
): SQL {
  const windowStart = naiveDayStart(from);
  const windowEnd = naiveDayEndExclusive(through);
  const exposureAge = sql`make_interval(mins => ${TICKET_EXPOSURE_AGE_MINUTES})`;
  const horizon = sql`make_interval(hours => ${TICKET_RESPONSE_HORIZON_HOURS})`;
  const entry = sql`(${tickets.createdAt} + ${exposureAge})`;
  const censorAt = sql`LEAST(${windowEnd}, (now() AT TIME ZONE 'UTC'))`;
  const responded = sql`(
    ${tickets.firstResponseAt} IS NOT NULL
    AND ${tickets.firstResponseAt} < ${windowEnd}
  )`;

  return sql`
    WITH exposure AS (${ticketExposureCte(orgIds, from, through)})
    SELECT
      ${tickets.id} AS ticket_id,
      ${tickets.orgId} AS org_id,
      ${tickets.priority} AS priority,
      COALESCE(${tickets.category}, '') AS category,
      exposure.exposure_at AS exposure_at,
      (exposure.exposure_at IS NOT NULL AND exposure.exposure_at <= ${entry}) AS ai_touched,
      ${responded} AS observed,
      GREATEST(
        0,
        EXTRACT(EPOCH FROM (
          CASE WHEN ${responded} THEN ${tickets.firstResponseAt} ELSE ${censorAt} END
          - ${entry}
        )) / 60.0
      ) AS minutes,
      (${entry} + ${horizon} <= ${windowEnd}) AS has_followup
    FROM ${tickets}
    LEFT JOIN exposure ON exposure.ticket_id = ${tickets.id}
    WHERE ${inArray(tickets.orgId, [...orgIds])}
      ${orgCondition ? sql`AND ${orgCondition}` : sql``}
      AND ${tickets.deletedAt} IS NULL
      AND ${tickets.createdAt} >= ${windowStart}
      AND ${tickets.createdAt} < ${windowEnd}
      AND (${tickets.firstResponseAt} IS NULL OR ${tickets.firstResponseAt} >= ${entry})
  `;
}

/**
 * Recorded technician minutes per ticket, with the arm the ticket falls into.
 *
 * `time_entries` is a **partner-axis** table: `partner_id NOT NULL`, `org_id`
 * nullable. It therefore has no org-axis RLS policy and `time_entries.org_id`
 * must NOT be used as the tenancy filter — it may legitimately be NULL. The join
 * is to `tickets` on `ticket_id`, and the *tickets* side carries
 * `auth.orgCondition(tickets.orgId)`.
 *
 * A running timer has `duration_minutes` NULL (`db/schema/timeTracking.ts`), and
 * an absent entry is **missing information, not zero labour** — so minutes are
 * summed over completed entries only, and a ticket with no completed entry is
 * reported through `logged = false` rather than as a zero.
 */
export function ticketRecordedMinutesQuery(
  orgIds: readonly string[],
  from: string,
  through: string,
  orgCondition: SQL | undefined,
): SQL {
  const windowStart = naiveDayStart(from);
  const windowEnd = naiveDayEndExclusive(through);
  const exposureAge = sql`make_interval(mins => ${TICKET_EXPOSURE_AGE_MINUTES})`;
  const entry = sql`(${tickets.createdAt} + ${exposureAge})`;

  return sql`
    WITH exposure AS (${ticketExposureCte(orgIds, from, through)})
    SELECT
      ${tickets.id} AS ticket_id,
      ${tickets.priority} AS priority,
      COALESCE(${tickets.category}, '') AS category,
      (exposure.exposure_at IS NOT NULL AND exposure.exposure_at <= ${entry}) AS ai_touched,
      SUM(${timeEntries.durationMinutes}) AS recorded_minutes
    FROM ${tickets}
    LEFT JOIN exposure ON exposure.ticket_id = ${tickets.id}
    LEFT JOIN ${timeEntries}
      ON ${timeEntries.ticketId} = ${tickets.id}
     -- A running timer contributes nothing; it is not zero labour, it is labour
     -- not yet recorded.
     AND ${timeEntries.durationMinutes} IS NOT NULL
    WHERE ${inArray(tickets.orgId, [...orgIds])}
      ${orgCondition ? sql`AND ${orgCondition}` : sql``}
      AND ${tickets.deletedAt} IS NULL
      AND ${tickets.createdAt} >= ${windowStart}
      AND ${tickets.createdAt} < ${windowEnd}
    GROUP BY ${tickets.id}, ${tickets.priority}, ${tickets.category}, exposure.exposure_at, ${tickets.createdAt}
  `;
}
