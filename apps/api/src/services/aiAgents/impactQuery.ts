// apps/api/src/services/aiAgents/impactQuery.ts
/**
 * P2-6 (#4193, Task A7) — the impact DTO assembly service.
 *
 * Turns `ai_agent_impact_daily` (+ a live read of `ai_alert_verdicts` for
 * feedback) into the `AiAgentImpactDto` the impact routes and PDF export
 * serve. Runs under the CALLER's request DB context — RLS enforces tenant
 * isolation, but every statement additionally carries `auth.orgCondition(...)`
 * because partner scope means ACCESSIBLE orgs, not automatically every org
 * under the partner (see the plan's "Tenancy invariants").
 *
 * Three statements total, each aggregated server-side (never fetched as raw
 * org-day rows into Node):
 *   1. series + totals — ONE grouped statement over `ai_agent_impact_daily`,
 *      GROUP BY day.
 *   2. byOrg — partner scope only, GROUP BY org.
 *   3. positiveFeedback — a LIVE count against `ai_alert_verdicts` (not the
 *      rollup, which does not track feedback).
 *
 * `estSecondsSaved` is never stored — it is `estimateSecondsSaved` applied at
 * READ time to the summed counters and the partner's effective
 * `ImpactWeights`, so re-pricing a weight re-prices history instead of
 * forking it. See `db/schema/aiAgentImpactDaily.ts`'s docstring.
 *
 * Leak rules (plan): the DTO carries counters, org ids/names, weights and
 * dates only — never a run summary, verdict rationale, ticket text, intent
 * `reason`, or tool arguments. Nothing model-authored reaches this surface.
 */
import { and, asc, eq, gte, isNull, lte, sql, type SQL } from 'drizzle-orm';
import {
  AI_AGENT_IMPACT_BY_ORG_LIMIT,
  AI_AGENT_IMPACT_COUNTER_KEYS,
  AI_AGENT_IMPACT_DTO_SCHEMA_VERSION,
  estimateSecondsSaved,
  type AiAgentImpactBucketDto,
  type AiAgentImpactCounterKey,
  type AiAgentImpactCounters,
  type AiAgentImpactDto,
  type AiAgentImpactOrgRowDto,
  type AiAgentImpactTotalsDto,
  type AiAgentImpactWindow,
} from '@breeze/shared';
import { db } from '../../db';
import { aiAgentImpactDaily } from '../../db/schema/aiAgentImpactDaily';
import { aiAlertVerdicts } from '../../db/schema/aiAlertVerdicts';
import { organizations } from '../../db/schema/orgs';
import type { AuthContext } from '../../middleware/auth';
import { canManagePartnerWidePolicies } from '../partnerWideAccess';
import { lastCompleteUtcDay, shiftUtcDay, type UtcDay } from './impactRollup';
import { loadImpactWeights, resolveImpactPartnerId } from './impactWeights';

export interface ImpactQueryInput {
  window: AiAgentImpactWindow;
  orgId?: string;
}

/**
 * Thrown when `input.orgId` is not in the caller's accessible set. The route
 * checks first and answers 403; this is the defensive second gate so a future
 * non-route caller cannot skip it.
 */
export class ImpactOrgAccessDeniedError extends Error {
  constructor(message = 'The requested organization is not accessible to this caller') {
    super(message);
    this.name = 'ImpactOrgAccessDeniedError';
  }
}

/** Fields present on every counter row this file reads, before zero-fill/estimate. */
interface RawImpactCounterFields {
  alertsJudged: number;
  noiseFlagged: number;
  suppressionsApplied: number;
  ticketsTriaged: number;
  draftsSent: number;
  fixesProposed: number;
  fixesExecuted: number;
  fixWatchesHeld: number;
  fixWatchesRecurred: number;
  narrativesDelivered: number;
  llmCents: number;
}

interface RawSeriesRow extends RawImpactCounterFields {
  day: string;
  rebuiltAt: unknown;
}

interface RawOrgRow extends RawImpactCounterFields {
  orgId: string;
  orgName: string;
}

const ZERO_COUNTERS: AiAgentImpactCounters = Object.freeze(
  AI_AGENT_IMPACT_COUNTER_KEYS.reduce((acc, key) => {
    acc[key] = 0;
    return acc;
  }, {} as AiAgentImpactCounters)
);

function extractCounters(row: RawImpactCounterFields): AiAgentImpactCounters {
  const counters = {} as AiAgentImpactCounters;
  for (const key of AI_AGENT_IMPACT_COUNTER_KEYS) counters[key] = row[key];
  return counters;
}

function sumCounters(buckets: AiAgentImpactCounters[]): AiAgentImpactCounters {
  const totals = { ...ZERO_COUNTERS };
  for (const bucket of buckets) {
    for (const key of AI_AGENT_IMPACT_COUNTER_KEYS) totals[key] += bucket[key];
  }
  return totals;
}

/** The MINIMUM of a set of timestamp-ish values (`Date | string`, driver-dependent) — the conservative freshness answer. */
function earliestIso(values: unknown[]): string | null {
  let minMs: number | null = null;
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const ms = value instanceof Date ? value.getTime() : new Date(value as string).getTime();
    if (Number.isNaN(ms)) continue;
    if (minMs === null || ms < minMs) minMs = ms;
  }
  return minMs === null ? null : new Date(minMs).toISOString();
}

/**
 * The ten priced+unpriced counters, each `COALESCE(SUM(col), 0)::int` —
 * shared verbatim between the series/totals query and the byOrg query so the
 * two aggregations can never drift out of sync with each other or with
 * `AI_AGENT_IMPACT_COUNTER_KEYS`.
 */
const COUNTER_SUM_SELECT: Record<AiAgentImpactCounterKey, SQL<number>> = {
  alertsJudged: sql<number>`COALESCE(SUM(${aiAgentImpactDaily.alertsJudged}), 0)::int`,
  noiseFlagged: sql<number>`COALESCE(SUM(${aiAgentImpactDaily.noiseFlagged}), 0)::int`,
  suppressionsApplied: sql<number>`COALESCE(SUM(${aiAgentImpactDaily.suppressionsApplied}), 0)::int`,
  ticketsTriaged: sql<number>`COALESCE(SUM(${aiAgentImpactDaily.ticketsTriaged}), 0)::int`,
  draftsSent: sql<number>`COALESCE(SUM(${aiAgentImpactDaily.draftsSent}), 0)::int`,
  fixesProposed: sql<number>`COALESCE(SUM(${aiAgentImpactDaily.fixesProposed}), 0)::int`,
  fixesExecuted: sql<number>`COALESCE(SUM(${aiAgentImpactDaily.fixesExecuted}), 0)::int`,
  fixWatchesHeld: sql<number>`COALESCE(SUM(${aiAgentImpactDaily.fixWatchesHeld}), 0)::int`,
  fixWatchesRecurred: sql<number>`COALESCE(SUM(${aiAgentImpactDaily.fixWatchesRecurred}), 0)::int`,
  narrativesDelivered: sql<number>`COALESCE(SUM(${aiAgentImpactDaily.narrativesDelivered}), 0)::int`,
};
const LLM_CENTS_SUM = sql<number>`COALESCE(SUM(${aiAgentImpactDaily.llmCents}), 0)::int`;

/**
 * Assembles the whole DTO. Runs under the CALLER's request DB context — every
 * statement carries `auth.orgCondition(...)` on top of RLS, because partner
 * scope means ACCESSIBLE orgs, not every org under the partner.
 */
export async function loadImpactSummary(auth: AuthContext, input: ImpactQueryInput): Promise<AiAgentImpactDto> {
  // Org narrowing (plan step 2). For `system` scope an orgId is REQUIRED —
  // the route enforces the 400 before ever calling in; this is the
  // defensive second gate so a future non-route caller (a script, an MCP
  // tool) cannot skip it and silently query every org's impact in one shot.
  if (input.orgId !== undefined) {
    if (!auth.canAccessOrg(input.orgId)) throw new ImpactOrgAccessDeniedError();
  } else if (auth.scope === 'system') {
    throw new Error(
      'loadImpactSummary: a system-scoped query requires input.orgId (the route enforces this as a 400 before calling in)'
    );
  }

  const through: UtcDay = lastCompleteUtcDay();
  const from: UtcDay = shiftUtcDay(through, -(input.window - 1));

  const impactOrgCondition = auth.orgCondition(aiAgentImpactDaily.orgId);
  const impactOrgFilter = input.orgId !== undefined ? eq(aiAgentImpactDaily.orgId, input.orgId) : undefined;
  const impactDayRangeWhere = and(
    impactOrgCondition,
    impactOrgFilter,
    gte(aiAgentImpactDaily.day, from),
    lte(aiAgentImpactDaily.day, through)
  );

  const verdictOrgFilter = input.orgId !== undefined ? eq(aiAlertVerdicts.orgId, input.orgId) : undefined;
  const feedbackWhere = and(
    auth.orgCondition(aiAlertVerdicts.orgId),
    verdictOrgFilter,
    isNull(aiAlertVerdicts.supersededBy),
    sql`${aiAlertVerdicts.feedbackAt} >= (${from}::date) AT TIME ZONE 'UTC'`,
    sql`${aiAlertVerdicts.feedbackAt} < (${through}::date + 1) AT TIME ZONE 'UTC'`
  );

  const [rawSeriesRows, rawByOrgRows, rawFeedbackRows, partnerId] = await Promise.all([
    db
      .select({
        day: aiAgentImpactDaily.day,
        ...COUNTER_SUM_SELECT,
        llmCents: LLM_CENTS_SUM,
        rebuiltAt: sql<unknown>`MIN(${aiAgentImpactDaily.rebuiltAt})`,
      })
      .from(aiAgentImpactDaily)
      .where(impactDayRangeWhere)
      .groupBy(aiAgentImpactDaily.day)
      .orderBy(asc(aiAgentImpactDaily.day)),
    auth.scope === 'partner'
      ? db
          .select({
            orgId: aiAgentImpactDaily.orgId,
            orgName: organizations.name,
            ...COUNTER_SUM_SELECT,
            llmCents: LLM_CENTS_SUM,
          })
          .from(aiAgentImpactDaily)
          .innerJoin(organizations, eq(organizations.id, aiAgentImpactDaily.orgId))
          .where(impactDayRangeWhere)
          .groupBy(aiAgentImpactDaily.orgId, organizations.name)
      : Promise.resolve<RawOrgRow[]>([]),
    db
      .select({
        up: sql<number>`COUNT(*) FILTER (WHERE ${aiAlertVerdicts.feedback} = 'up')::int`,
        down: sql<number>`COUNT(*) FILTER (WHERE ${aiAlertVerdicts.feedback} = 'down')::int`,
      })
      .from(aiAlertVerdicts)
      .where(feedbackWhere),
    resolveImpactPartnerId(auth, input.orgId),
  ]);

  const { effective, overrides } = await loadImpactWeights(partnerId);

  // Zero-fill: `series.length === input.window` always, so the chart never
  // silently compresses a gap left by a day the rollup hasn't reached yet.
  const byDay = new Map<UtcDay, RawSeriesRow>((rawSeriesRows as RawSeriesRow[]).map((row) => [row.day, row]));
  const series: AiAgentImpactBucketDto[] = [];
  for (let i = 0; i < input.window; i++) {
    const day = shiftUtcDay(from, i);
    const raw = byDay.get(day);
    const counters = raw ? extractCounters(raw) : ZERO_COUNTERS;
    series.push({
      day,
      ...counters,
      llmCents: raw ? raw.llmCents : 0,
      estSecondsSaved: estimateSecondsSaved(counters, effective),
    });
  }

  const totalCounters = sumCounters(series.map((bucket) => extractCounters(bucket)));
  const totalLlmCents = series.reduce((sum, bucket) => sum + bucket.llmCents, 0);
  const totals: AiAgentImpactTotalsDto = {
    ...totalCounters,
    llmCents: totalLlmCents,
    estSecondsSaved: estimateSecondsSaved(totalCounters, effective),
  };

  const rebuiltAt = earliestIso((rawSeriesRows as RawSeriesRow[]).map((row) => row.rebuiltAt));

  const byOrgAll: AiAgentImpactOrgRowDto[] = (rawByOrgRows as RawOrgRow[]).map((row) => {
    const counters = extractCounters(row);
    return {
      orgId: row.orgId,
      orgName: row.orgName,
      ...counters,
      llmCents: row.llmCents,
      estSecondsSaved: estimateSecondsSaved(counters, effective),
    };
  });
  byOrgAll.sort((a, b) => b.estSecondsSaved - a.estSecondsSaved);
  const byOrgTruncated = byOrgAll.length > AI_AGENT_IMPACT_BY_ORG_LIMIT;
  const byOrg = byOrgAll.slice(0, AI_AGENT_IMPACT_BY_ORG_LIMIT);

  const feedbackRow = (rawFeedbackRows as Array<{ up: number; down: number }>)[0] ?? { up: 0, down: 0 };
  const feedbackTotal = feedbackRow.up + feedbackRow.down;
  const positiveFeedback = {
    up: feedbackRow.up,
    down: feedbackRow.down,
    rate: feedbackTotal === 0 ? null : feedbackRow.up / feedbackTotal,
  };

  return {
    schemaVersion: AI_AGENT_IMPACT_DTO_SCHEMA_VERSION,
    window: input.window,
    through,
    rebuiltAt,
    totals,
    series,
    byOrg,
    byOrgTruncated,
    positiveFeedback,
    // P2-6b (#4193 follow-up): reads P2-5's ai_agent_graduation, which has
    // not landed.
    promoteEligibleCount: null,
    weights: { effective, overrides },
    canEditWeights: canManagePartnerWidePolicies(auth),
  };
}
