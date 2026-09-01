// apps/api/src/services/aiAgents/impactRollup.ts
import { AI_AGENT_IMPACT_REBUILD_DAYS } from '@breeze/shared';
import { sql, type SQL } from 'drizzle-orm';

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { impactFixToolsArray } from './impactFixTools';

/**
 * Phase 2 wave P2-6 (#4193) — the `ai_agent_impact_daily` rebuild service.
 *
 * Persistence mirrors `services/metricRollups.ts` end-to-end: ONE idempotent
 * `INSERT … SELECT … ON CONFLICT DO UPDATE` per (org, range) over a
 * `generate_series` day grid, run inside its OWN short-lived labelled system
 * context preceded by `runOutsideDbContext`.
 *
 * CALLERS MUST NOT WRAP THESE FUNCTIONS IN THEIR OWN DB CONTEXT. The
 * `runOutsideDbContext` escape is not decoration: without it a caller's
 * ambient context would make the inner `withSystemDbAccessContext`
 * short-circuit into that transaction and collapse the short hold into a long
 * one (the alertWorker/#3216 trap). WITH the escape an outer wrap is instead
 * defeated — it does no work and merely pins a second idle-in-transaction
 * connection for the whole pass. The rollup worker and the integration suite
 * both call these bare.
 *
 * Every bucket boundary is an explicit UTC calendar day. `date_trunc('day',
 * <timestamptz>)` is deliberately never used anywhere in this file: it follows
 * the session timezone, which a self-hoster can change, so it would silently
 * re-bucket an entire fleet's history. Ranges are bounded half-open on
 * `(<day>::date) AT TIME ZONE 'UTC'` instead, which keeps the predicates
 * sargable against the source indexes this wave adds.
 */

/** `YYYY-MM-DD` for a UTC calendar day. */
export type UtcDay = string;

export interface ImpactRebuildResult {
  orgId: string;
  fromDay: UtcDay;
  toDay: UtcDay;
  days: number;
}

const UTC_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

/**
 * Context labels. Low-cardinality by construction — one per pass, NEVER per
 * org or per range: the label becomes part of the grouped Sentry message for
 * `db_context_held_too_long`, and a per-org label would shatter that grouping
 * into one issue per tenant.
 */
const REBUILD_CONTEXT_LABEL = 'aiAgentImpactRollup.rebuild';
const DISCOVER_CONTEXT_LABEL = 'aiAgentImpactRollup.discoverOrgs';
const BOOTSTRAP_CONTEXT_LABEL = 'aiAgentImpactRollup.bootstrapProbe';

function parseUtcDay(day: UtcDay): number {
  if (typeof day !== 'string' || !UTC_DAY_PATTERN.test(day)) {
    throw new Error(`Invalid UTC day: ${String(day)}`);
  }
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  // V8 ROLLS OVER an out-of-range calendar date rather than rejecting it
  // (`2026-02-30` parses as 2026-03-02), so the NaN check alone is not enough.
  // Round-tripping the formatted day back is what actually rejects it — a
  // silently shifted bucket boundary is exactly the class of bug this file
  // exists to avoid.
  if (Number.isNaN(ms) || formatUtcDay(ms) !== day) throw new Error(`Invalid UTC day: ${day}`);
  return ms;
}

function formatUtcDay(epochMs: number): UtcDay {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/** The last COMPLETE UTC day (today − 1). Never returns the current UTC day. */
export function lastCompleteUtcDay(now: Date = new Date()): UtcDay {
  const nowMs = now.getTime();
  if (Number.isNaN(nowMs)) throw new Error('Invalid date passed to lastCompleteUtcDay');
  return formatUtcDay(Math.floor(nowMs / MS_PER_DAY) * MS_PER_DAY - MS_PER_DAY);
}

/** `day` shifted by `deltaDays` in the UTC calendar. */
export function shiftUtcDay(day: UtcDay, deltaDays: number): UtcDay {
  if (!Number.isInteger(deltaDays)) throw new Error(`Invalid UTC day shift: ${String(deltaDays)}`);
  return formatUtcDay(parseUtcDay(day) + deltaDays * MS_PER_DAY);
}

/** Inclusive day count between two UtcDays. */
export function utcDaySpan(fromDay: UtcDay, toDay: UtcDay): number {
  return Math.round((parseUtcDay(toDay) - parseUtcDay(fromDay)) / MS_PER_DAY) + 1;
}

/**
 * Validate a rebuild range and return its inclusive day count. Mirrors
 * `normalizeRange` (`services/metricRollups.ts:130-138`): an inverted range is
 * a caller bug, and swallowing it would upsert nothing while reporting
 * success.
 */
function normalizeImpactDayRange(fromDay: UtcDay, toDay: UtcDay): number {
  const days = utcDaySpan(fromDay, toDay);
  if (days < 1) throw new Error(`Impact rollup range must have fromDay <= toDay (got ${fromDay}..${toDay})`);
  return days;
}

/** One rollup pass, in its OWN short-lived system context. See the module header. */
function inRollupDbContext<T>(label: string, fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn, label));
}

function rows<T>(result: unknown): T[] {
  const value = (result as { rows?: T[] }).rows ?? result;
  return Array.isArray(value) ? value : [];
}

/**
 * `IMPACT_FIX_TOOLS` as an explicit `ARRAY[$1, …]::text[]`.
 *
 * Binding the JS array directly (`= ANY(${tools}::text[])`) makes drizzle
 * expand it to a ROW constructor — `ANY(($1, $2, …)::text[])` — which a live
 * server rejects. Same trap, same fix as
 * `extensions/tenancyTripwire.ts:224-229`; it has already cost this repo one
 * boot-aborting incident (`extensions/builtinTableProbe.integration.test.ts`).
 */
function fixToolsArraySql(): SQL {
  return sql`ARRAY[${sql.join(impactFixToolsArray().map((tool) => sql`${tool}`), sql`, `)}]::text[]`;
}

/**
 * ONE idempotent `INSERT … SELECT … ON CONFLICT DO UPDATE` over a
 * generate_series day grid for [fromDay, toDay] inclusive. Emits a ZERO row for
 * every day with no source facts, so a removed or reclassified fact cannot
 * leave a stale nonzero bucket behind.
 *
 * Runs in its own short-lived labelled system context preceded by
 * `runOutsideDbContext`. Callers MUST NOT wrap this in their own context — the
 * escape defeats an outer wrap and merely pins a second idle-in-transaction
 * connection.
 */
export async function rebuildOrgImpactRange(orgId: string, fromDay: UtcDay, toDay: UtcDay): Promise<ImpactRebuildResult> {
  const days = normalizeImpactDayRange(fromDay, toDay);
  const fixTools = fixToolsArraySql();

  await inRollupDbContext(REBUILD_CONTEXT_LABEL, () => db.execute(sql`
    WITH days AS (
      SELECT d::date AS day
      FROM generate_series(${fromDay}::date, ${toDay}::date, interval '1 day') AS d
    ),
    verdicts AS (
      SELECT (v.created_at AT TIME ZONE 'UTC')::date AS day,
             count(*)::int AS alerts_judged,
             count(*) FILTER (WHERE v.classification IN
               ('transient_self_healed', 'recurring_pattern', 'duplicate_of_group'))::int AS noise_flagged
      FROM ai_alert_verdicts v
      WHERE v.org_id = ${orgId}::uuid
        AND v.created_at >= (${fromDay}::date) AT TIME ZONE 'UTC'
        AND v.created_at <  (${toDay}::date + 1) AT TIME ZONE 'UTC'
      GROUP BY 1
    ),
    suppressions AS (
      SELECT (i.executed_at AT TIME ZONE 'UTC')::date AS day, count(*)::int AS suppressions_applied
      FROM action_intents i
      WHERE i.org_id = ${orgId}::uuid
        AND i.origin_principal_kind = 'ai_agent'
        AND i.action_name = 'manage_alerts'
        AND i.arguments->>'action' = 'suppress'
        AND i.status = 'completed'
        AND i.executed_at >= (${fromDay}::date) AT TIME ZONE 'UTC'
        AND i.executed_at <  (${toDay}::date + 1) AT TIME ZONE 'UTC'
      GROUP BY 1
    ),
    triage AS (
      SELECT (r.finished_at AT TIME ZONE 'UTC')::date AS day, count(*)::int AS tickets_triaged
      FROM ai_agent_runs r
      WHERE r.org_id = ${orgId}::uuid
        AND r.profile = 'triage'
        AND r.status IN ('completed', 'awaiting_approval')
        AND r.error_code IS NULL
        AND r.outcome ? 'ticketProposal'
        AND r.finished_at >= (${fromDay}::date) AT TIME ZONE 'UTC'
        AND r.finished_at <  (${toDay}::date + 1) AT TIME ZONE 'UTC'
      GROUP BY 1
    ),
    drafts AS (
      SELECT (d.consumed_at AT TIME ZONE 'UTC')::date AS day, count(*)::int AS drafts_sent
      FROM ticket_drafts d
      WHERE d.org_id = ${orgId}::uuid
        AND d.state = 'consumed'
        AND d.consumed_at >= (${fromDay}::date) AT TIME ZONE 'UTC'
        AND d.consumed_at <  (${toDay}::date + 1) AT TIME ZONE 'UTC'
      GROUP BY 1
    ),
    proposed AS (
      SELECT day, count(*)::int AS fixes_proposed FROM (
        -- Arm (a): Tier-3 proposals, which DO mint an intent.
        SELECT (i.created_at AT TIME ZONE 'UTC')::date AS day
        FROM action_intents i
        WHERE i.org_id = ${orgId}::uuid
          AND i.origin_principal_kind = 'ai_agent'
          AND i.action_name = ANY(${fixTools})
          AND i.created_at >= (${fromDay}::date) AT TIME ZONE 'UTC'
          AND i.created_at <  (${toDay}::date + 1) AT TIME ZONE 'UTC'
        UNION ALL
        -- Arm (b): ordinary Tier-2 proposals, which exist ONLY in the run outcome
        -- (runLoop.ts:798-860 — recordProposal creates an intent for tier 3 only).
        -- The intentId IS NULL predicate is what keeps the two arms disjoint.
        SELECT (r.finished_at AT TIME ZONE 'UTC')::date AS day
        FROM ai_agent_runs r
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(r.outcome->'proposedActions') = 'array'
               THEN r.outcome->'proposedActions' ELSE '[]'::jsonb END
        ) AS p(item)
        WHERE r.org_id = ${orgId}::uuid
          AND r.profile = 'full'
          AND r.finished_at >= (${fromDay}::date) AT TIME ZONE 'UTC'
          AND r.finished_at <  (${toDay}::date + 1) AT TIME ZONE 'UTC'
          AND p.item->>'intentId' IS NULL
          AND p.item->>'tool' = ANY(${fixTools})
      ) s GROUP BY 1
    ),
    executed AS (
      SELECT day, count(*)::int AS fixes_executed FROM (
        -- Arm (a): released intents.
        SELECT (i.executed_at AT TIME ZONE 'UTC')::date AS day
        FROM action_intents i
        WHERE i.org_id = ${orgId}::uuid
          AND i.origin_principal_kind = 'ai_agent'
          AND i.action_name = ANY(${fixTools})
          AND i.status = 'completed'
          AND i.executed_at >= (${fromDay}::date) AT TIME ZONE 'UTC'
          AND i.executed_at <  (${toDay}::date + 1) AT TIME ZONE 'UTC'
        UNION ALL
        -- Arm (b): act-mode direct executions (a separate execution path — no
        -- intent is ever created for these). A verify-FAILED execution earns no
        -- value: computeRunVerdict (runLoop.ts:1299-1312) only treats
        -- succeeded+passed as clean, and this predicate is the accounting mirror
        -- of that rule.
        SELECT (r.finished_at AT TIME ZONE 'UTC')::date AS day
        FROM ai_agent_runs r
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(r.outcome->'executedActions') = 'array'
               THEN r.outcome->'executedActions' ELSE '[]'::jsonb END
        ) AS a(item)
        WHERE r.org_id = ${orgId}::uuid
          AND r.profile = 'full'
          AND r.mode_at_start = 'act'
          AND r.finished_at >= (${fromDay}::date) AT TIME ZONE 'UTC'
          AND r.finished_at <  (${toDay}::date + 1) AT TIME ZONE 'UTC'
          AND a.item->>'actOpKey' IS NOT NULL
          AND a.item->>'execution' = 'succeeded'
          AND COALESCE(a.item->>'verification', 'skipped') <> 'failed'
      ) s GROUP BY 1
    ),
    watches AS (
      SELECT (w.evaluated_at AT TIME ZONE 'UTC')::date AS day,
             count(*) FILTER (WHERE w.state = 'held_qualified')::int AS fix_watches_held,
             count(*) FILTER (WHERE w.state = 'recurred')::int      AS fix_watches_recurred
      FROM ai_agent_fix_watches w
      WHERE w.org_id = ${orgId}::uuid
        AND w.evaluated_at >= (${fromDay}::date) AT TIME ZONE 'UTC'
        AND w.evaluated_at <  (${toDay}::date + 1) AT TIME ZONE 'UTC'
      GROUP BY 1
    ),
    narratives AS (
      SELECT (r.finished_at AT TIME ZONE 'UTC')::date AS day, count(*)::int AS narratives_delivered
      FROM ai_agent_runs r
      WHERE r.org_id = ${orgId}::uuid
        AND r.profile = 'narrative'
        AND r.status = 'completed'
        AND r.report_run_id IS NOT NULL
        AND r.finished_at >= (${fromDay}::date) AT TIME ZONE 'UTC'
        AND r.finished_at <  (${toDay}::date + 1) AT TIME ZONE 'UTC'
      GROUP BY 1
    ),
    cost AS (
      -- ALL profiles and statuses, attributed by the immutable queued_at (the same
      -- column runService.ts:983-993 uses for the daily agent budget).
      SELECT (r.queued_at AT TIME ZONE 'UTC')::date AS day,
             COALESCE(SUM(r.cost_cents), 0)::int AS llm_cents
      FROM ai_agent_runs r
      WHERE r.org_id = ${orgId}::uuid
        AND r.queued_at >= (${fromDay}::date) AT TIME ZONE 'UTC'
        AND r.queued_at <  (${toDay}::date + 1) AT TIME ZONE 'UTC'
      GROUP BY 1
    )
    INSERT INTO ai_agent_impact_daily (
      org_id, day, alerts_judged, noise_flagged, suppressions_applied, tickets_triaged,
      drafts_sent, fixes_proposed, fixes_executed, fix_watches_held, fix_watches_recurred,
      narratives_delivered, llm_cents, rebuilt_at
    )
    SELECT
      ${orgId}::uuid, days.day,
      COALESCE(v.alerts_judged, 0), COALESCE(v.noise_flagged, 0),
      COALESCE(s.suppressions_applied, 0), COALESCE(t.tickets_triaged, 0),
      COALESCE(dr.drafts_sent, 0), COALESCE(p.fixes_proposed, 0),
      COALESCE(e.fixes_executed, 0), COALESCE(w.fix_watches_held, 0),
      COALESCE(w.fix_watches_recurred, 0), COALESCE(n.narratives_delivered, 0),
      COALESCE(c.llm_cents, 0), now()
    FROM days
    LEFT JOIN verdicts     v  ON v.day  = days.day
    LEFT JOIN suppressions s  ON s.day  = days.day
    LEFT JOIN triage       t  ON t.day  = days.day
    LEFT JOIN drafts       dr ON dr.day = days.day
    LEFT JOIN proposed     p  ON p.day  = days.day
    LEFT JOIN executed     e  ON e.day  = days.day
    LEFT JOIN watches      w  ON w.day  = days.day
    LEFT JOIN narratives   n  ON n.day  = days.day
    LEFT JOIN cost         c  ON c.day  = days.day
    ON CONFLICT (org_id, day) DO UPDATE SET
      alerts_judged        = EXCLUDED.alerts_judged,
      noise_flagged        = EXCLUDED.noise_flagged,
      suppressions_applied = EXCLUDED.suppressions_applied,
      tickets_triaged      = EXCLUDED.tickets_triaged,
      drafts_sent          = EXCLUDED.drafts_sent,
      fixes_proposed       = EXCLUDED.fixes_proposed,
      fixes_executed       = EXCLUDED.fixes_executed,
      fix_watches_held     = EXCLUDED.fix_watches_held,
      fix_watches_recurred = EXCLUDED.fix_watches_recurred,
      narratives_delivered = EXCLUDED.narratives_delivered,
      llm_cents            = EXCLUDED.llm_cents,
      rebuilt_at           = now()
  `));

  return { orgId, fromDay, toDay, days };
}

/**
 * Orgs with ANY impact-relevant fact in [fromDay, toDay]. Unions EVERY source
 * timestamp — runs.queued_at, runs.finished_at, verdicts.created_at,
 * intents.created_at, intents.executed_at, watches.evaluated_at,
 * drafts.consumed_at — because an org whose only activity in the window was a
 * consumed draft or an executed intent has no run row in it at all.
 *
 * Runs bare, in its own labelled system context. See the module header.
 */
export async function findImpactSourceOrgIds(fromDay: UtcDay, toDay: UtcDay): Promise<string[]> {
  normalizeImpactDayRange(fromDay, toDay);

  const result = await inRollupDbContext(DISCOVER_CONTEXT_LABEL, () => db.execute(sql`
    SELECT DISTINCT org_id FROM (
      SELECT org_id FROM ai_agent_runs
       WHERE queued_at   >= (${fromDay}::date) AT TIME ZONE 'UTC' AND queued_at   < (${toDay}::date + 1) AT TIME ZONE 'UTC'
      UNION SELECT org_id FROM ai_agent_runs
       WHERE finished_at >= (${fromDay}::date) AT TIME ZONE 'UTC' AND finished_at < (${toDay}::date + 1) AT TIME ZONE 'UTC'
      UNION SELECT org_id FROM ai_alert_verdicts
       WHERE created_at  >= (${fromDay}::date) AT TIME ZONE 'UTC' AND created_at  < (${toDay}::date + 1) AT TIME ZONE 'UTC'
      UNION SELECT org_id FROM action_intents
       WHERE origin_principal_kind = 'ai_agent'
         AND created_at  >= (${fromDay}::date) AT TIME ZONE 'UTC' AND created_at  < (${toDay}::date + 1) AT TIME ZONE 'UTC'
      UNION SELECT org_id FROM action_intents
       WHERE origin_principal_kind = 'ai_agent'
         AND executed_at >= (${fromDay}::date) AT TIME ZONE 'UTC' AND executed_at < (${toDay}::date + 1) AT TIME ZONE 'UTC'
      UNION SELECT org_id FROM ai_agent_fix_watches
       WHERE evaluated_at >= (${fromDay}::date) AT TIME ZONE 'UTC' AND evaluated_at < (${toDay}::date + 1) AT TIME ZONE 'UTC'
      UNION SELECT org_id FROM ticket_drafts
       WHERE state = 'consumed'
         AND consumed_at >= (${fromDay}::date) AT TIME ZONE 'UTC' AND consumed_at < (${toDay}::date + 1) AT TIME ZONE 'UTC'
    ) src
  `));

  return rows<{ org_id: string | null }>(result)
    .map((row) => row.org_id)
    .filter((orgId): orgId is string => typeof orgId === 'string' && orgId.length > 0);
}

/** True when the org has no bucket at `through − (AI_AGENT_IMPACT_REBUILD_DAYS - 1)`. */
export async function needsImpactBootstrap(orgId: string, through: UtcDay): Promise<boolean> {
  const oldestDay = shiftUtcDay(through, -(AI_AGENT_IMPACT_REBUILD_DAYS - 1));

  const result = await inRollupDbContext(BOOTSTRAP_CONTEXT_LABEL, () => db.execute(sql`
    SELECT 1 AS present
    FROM ai_agent_impact_daily
    WHERE org_id = ${orgId}::uuid
      AND day = ${oldestDay}::date
    LIMIT 1
  `));

  return rows(result).length === 0;
}
