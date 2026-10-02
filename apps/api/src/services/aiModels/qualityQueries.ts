/**
 * The AI model quality view (W11 #7609; spec §5.5 "Quality link", §7 prompt
 * profile, §13 W11). One SQL statement over the invocation ledger, scoped
 * exactly like the spend view (ledgerWhere: authoritative rows, inclusive UTC
 * range, the caller's org list, and RLS in the request context).
 *
 * Attribution (the same rule for every metric):
 *  - a call counts toward the offering CHOSEN for it: the bound offering, or
 *    W09's failover_from_offering_id (the dispatch's origin) when a failover
 *    hop served it. A refusal-fallback leg already carries the bound
 *    offering_id (W03 settleInvocation), so it counts toward the refused
 *    model. That is deliberately unlike the spend view, which groups by the
 *    model that SERVED the leg;
 *  - a conversation (a session, or an agent run) counts toward the group of
 *    its LAST call in the range, ordered by COALESCE(occurred_at, created_at)
 *    (a deferred settlement is inserted late; occurred_at keeps turn order);
 *  - a switch counts toward the group the conversation LEFT. Consecutive
 *    calls whose chosen offering differs make one switch. This covers W05's
 *    picker switches and §9.1's automatic switch to the assignment default.
 *
 * "Resolved" is a proxy (Breeze records no explicit outcome): a session that
 * finished (closed, expired, or idle SESSION_IDLE_SETTLE_HOURS), was not
 * flagged by a person, and was not continued elsewhere. Turns to resolve =
 * the technician's messages (ai_messages role 'user') in it and in the
 * sessions it continued from (W05). An agent run completes when its status
 * is 'completed', out of runs in a terminal status (turn_count counts SDK
 * steps, not turns, so runs get a completion rate instead).
 *
 * Automatic flags (a tool error, AUTO_FLAG_REASON_PREFIXES) are counted apart
 * and do not disqualify a session.
 */
import { sql, type SQL } from 'drizzle-orm';
import { AI_AGENT_RUN_STATUSES } from '@breeze/shared';
import type {
  AiQualityBreakdownDto,
  AiQualityGroupBy,
  AiQualityMetricsDto,
  AiQualityRowDto,
  AiQualitySourcesDto,
  AiSurface,
} from '@breeze/shared';
import { db } from '../../db';
import { lockTimeoutWasChanged, tightenStatementTimeout } from '../../db/lockTimeout';
import { errorSqlstate } from './safeDbError';
import { ledgerWhere, type LedgerScopeInput } from './usageQueries';
import { detectQualitySources, type QualitySources } from './qualitySources';

/** The reasons the platform writes when it flags a session itself (aiAgentSdk.ts, streamingSessionManager.ts). */
export const AUTO_FLAG_REASON_PREFIXES = ['Tool failed:', 'Tool rejected before execution:'] as const;
/** A session with no activity for this long counts as finished. */
export const SESSION_IDLE_SETTLE_HOURS = 24;
/** How many continuation hops (W05) a session's turns are summed across. */
export const CONTINUATION_CHAIN_MAX_DEPTH = 5;
/** Per-statement budget for both quality reads (route: 503 quality_timeout). */
export const QUALITY_STATEMENT_TIMEOUT_MS = 15_000;
/** Every run status except the in-flight ones (queued, running, awaiting_approval). */
const IN_FLIGHT_RUN_STATUSES: readonly string[] = ['queued', 'running', 'awaiting_approval'];
const TERMINAL_RUN_STATUSES = AI_AGENT_RUN_STATUSES.filter((st) => !IN_FLIGHT_RUN_STATUSES.includes(st));
const MAX_GROUPS = 200;

export type QualityGroupKey = AiQualityGroupBy | 'prompt_variant' | 'total';

export interface QualityQueryInput extends LedgerScopeInput {
  groupBy: QualityGroupKey;
  /** Narrow to these surfaces (the platform variant report passes the prompt-hook surfaces). */
  surfaces?: readonly AiSurface[] | null;
}

export class QualityQueryTimeoutError extends Error {
  constructor() {
    super('The quality view took too long for this range.');
    this.name = 'QualityQueryTimeoutError';
  }
}

function chosenOffering(s: QualitySources): SQL {
  return s.failover ? sql`COALESCE(i.failover_from_offering_id, i.offering_id)` : sql`i.offering_id`;
}

function groupKey(g: QualityGroupKey, s: QualitySources): SQL {
  switch (g) {
    case 'model': return sql`COALESCE((${chosenOffering(s)})::text, 'unattributed')`;
    case 'surface': return sql`i.surface`;
    case 'prompt_profile': return sql`COALESCE(i.prompt_profile, 'unrecorded')`;
    case 'prompt_variant': return sql`CASE WHEN i.prompt_variant IS NOT NULL THEN i.prompt_variant
      WHEN i.prompt_profile IS NOT NULL THEN i.surface || '/' || i.prompt_profile || '@base'
      ELSE 'unrecorded' END`;
    case 'total': return sql`'total'`;
  }
}

function labels(g: QualityGroupKey): { cols: SQL; join: SQL } {
  if (g !== 'model') return { cols: sql`NULL::text AS label, NULL::text AS connection_name`, join: sql`` };
  return {
    cols: sql`COALESCE(m.display_name, pm.display_name, m.model_id) AS label, pc.name AS connection_name`,
    join: sql`
      LEFT JOIN partner_ai_models m ON m.id::text = c.gkey
      LEFT JOIN ai_platform_models pm ON pm.id = m.platform_model_id
      LEFT JOIN partner_ai_connections pc ON pc.id = m.connection_id`,
  };
}

export function buildQualityQuery(input: QualityQueryInput, sources: QualitySources): SQL {
  const surfaceFilter = input.surfaces && input.surfaces.length > 0
    ? sql`AND i.surface IN (${sql.join(input.surfaces.map((s) => sql`${s}`), sql`, `)})`
    : sql``;
  const autoFlag = sql`(${sql.join(AUTO_FLAG_REASON_PREFIXES.map((p) => sql`starts_with(s.flag_reason, ${p})`), sql` OR `)})`;
  const continued = sources.continuation
    ? sql`EXISTS (SELECT 1 FROM ai_sessions cs WHERE cs.continued_from_session_id = f.session_id)`
    : sql`NULL::boolean`;
  const chain = sources.continuation
    ? sql`LEFT JOIN LATERAL (
        WITH RECURSIVE anc(id, depth) AS (
          SELECT s0.continued_from_session_id, 1 FROM ai_sessions s0
          WHERE s0.id = f.session_id AND s0.continued_from_session_id IS NOT NULL
          UNION ALL
          SELECT p.continued_from_session_id, anc.depth + 1 FROM anc JOIN ai_sessions p ON p.id = anc.id
          WHERE p.continued_from_session_id IS NOT NULL AND anc.depth < ${CONTINUATION_CHAIN_MAX_DEPTH}
        )
        SELECT COUNT(*)::int AS n FROM anc JOIN ai_messages am ON am.session_id = anc.id AND am.role = 'user'
      ) chain ON f.session_id IS NOT NULL`
    : sql`LEFT JOIN LATERAL (SELECT 0 AS n) chain ON true`;
  const terminal = sql.join(TERMINAL_RUN_STATUSES.map((st) => sql`${st}`), sql`, `);
  const label = labels(input.groupBy);
  const resolved = sql`(is_session AND settled AND NOT flagged AND NOT COALESCE(continued, false))`;

  return sql`
WITH ledger AS (
  SELECT i.id, i.session_id, i.agent_run_id, i.cost_cents, i.stop_reason,
    -- Turn order: when the turn was first settled; a deferred replay's INSERT is late.
    COALESCE(i.occurred_at, i.created_at) AS at,
    ${sources.failover ? sql`i.failover_hop` : sql`NULL::smallint`} AS failover_hop,
    ${chosenOffering(sources)} AS chosen_offering_id,
    ${groupKey(input.groupBy, sources)} AS gkey,
    COALESCE('s:' || i.session_id::text, 'r:' || i.agent_run_id::text) AS conv
  FROM ai_invocations i
  WHERE ${ledgerWhere(input)} ${surfaceFilter}
),
calls AS (
  SELECT gkey,
    COUNT(*) AS invocations,
    SUM(cost_cents) AS cost_cents,
    COUNT(*) FILTER (WHERE stop_reason = 'refusal') AS refusals,
    COUNT(*) FILTER (WHERE failover_hop > 0) AS failovers,
    COUNT(DISTINCT conv) AS touched,
    SUM(cost_cents) FILTER (WHERE conv IS NOT NULL) AS conversation_cost
  FROM ledger
  GROUP BY gkey
  ORDER BY SUM(cost_cents) DESC NULLS LAST, COUNT(*) DESC
  LIMIT ${sql.raw(String(MAX_GROUPS))}
),
ordered AS (
  SELECT conv, session_id, agent_run_id, gkey, chosen_offering_id,
    LEAD(chosen_offering_id) OVER (PARTITION BY conv ORDER BY at, id) AS next_chosen,
    ROW_NUMBER() OVER (PARTITION BY conv ORDER BY at DESC, id DESC) AS rn_desc
  FROM ledger
  WHERE conv IS NOT NULL
),
switched AS (
  SELECT gkey, COUNT(DISTINCT conv) AS switched_away
  FROM ordered
  WHERE rn_desc > 1 AND next_chosen IS DISTINCT FROM chosen_offering_id
  GROUP BY gkey
),
facts AS (
  SELECT f.gkey, f.conv,
    f.session_id IS NOT NULL AS is_session,
    COALESCE(s.flagged_at IS NOT NULL AND NOT COALESCE(${autoFlag}, false), false) AS flagged,
    COALESCE(s.flagged_at IS NOT NULL AND COALESCE(${autoFlag}, false), false) AS auto_flagged,
    CASE WHEN f.session_id IS NOT NULL THEN ${continued} END AS continued,
    CASE WHEN f.session_id IS NOT NULL
      THEN COALESCE(s.status <> 'active'
        OR s.last_activity_at < (now() AT TIME ZONE 'UTC') - make_interval(hours => ${SESSION_IDLE_SETTLE_HOURS}), false)
      ELSE COALESCE(r.status IN (${terminal}), false) END AS settled,
    COALESCE(own.n, 0) + COALESCE(chain.n, 0) AS session_turns,
    r.status AS run_status
  FROM ordered f
  LEFT JOIN ai_sessions s ON s.id = f.session_id
  LEFT JOIN ai_agent_runs r ON r.id = f.agent_run_id
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS n FROM ai_messages um WHERE um.session_id = f.session_id AND um.role = 'user'
  ) own ON f.session_id IS NOT NULL
  ${chain}
  WHERE f.rn_desc = 1
),
conv AS (
  SELECT gkey,
    COUNT(*) AS conversations,
    COUNT(*) FILTER (WHERE is_session) AS sessions,
    COUNT(*) FILTER (WHERE flagged) AS flagged,
    COUNT(*) FILTER (WHERE auto_flagged) AS auto_flagged,
    COUNT(*) FILTER (WHERE continued) AS continued,
    COUNT(*) FILTER (WHERE ${resolved}) AS resolved_sessions,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY session_turns) FILTER (WHERE ${resolved}) AS median_turns,
    COUNT(*) FILTER (WHERE NOT is_session AND settled) AS agent_runs,
    COUNT(*) FILTER (WHERE NOT is_session AND run_status = 'completed') AS agent_runs_completed
  FROM facts
  GROUP BY gkey
),
-- A conversation that switched away from a group AND was then continued
-- counts once (a distinct union, not switched + continued).
left_convs AS (
  SELECT gkey, COUNT(DISTINCT conv) AS left_conversations
  FROM (
    SELECT gkey, conv FROM ordered WHERE rn_desc > 1 AND next_chosen IS DISTINCT FROM chosen_offering_id
    UNION
    SELECT gkey, conv FROM facts WHERE continued
  ) l
  GROUP BY gkey
)
SELECT c.gkey AS key, ${label.cols},
  c.invocations::text AS invocations, c.cost_cents::text AS cost_cents, c.refusals::text AS refusals,
  c.failovers::text AS failovers, c.touched::text AS touched, c.conversation_cost::text AS conversation_cost,
  COALESCE(v.conversations, 0)::text AS conversations, COALESCE(v.sessions, 0)::text AS sessions,
  COALESCE(v.flagged, 0)::text AS flagged, COALESCE(v.auto_flagged, 0)::text AS auto_flagged,
  COALESCE(v.continued, 0)::text AS continued, COALESCE(v.resolved_sessions, 0)::text AS resolved_sessions,
  v.median_turns::text AS median_turns,
  COALESCE(v.agent_runs, 0)::text AS agent_runs, COALESCE(v.agent_runs_completed, 0)::text AS agent_runs_completed,
  COALESCE(sw.switched_away, 0)::text AS switched_away,
  COALESCE(lc.left_conversations, 0)::text AS left_conversations
FROM calls c
LEFT JOIN conv v ON v.gkey = c.gkey
LEFT JOIN switched sw ON sw.gkey = c.gkey
LEFT JOIN left_convs lc ON lc.gkey = c.gkey
${label.join}
ORDER BY c.cost_cents DESC NULLS LAST, c.invocations DESC`;
}

export type RawQualityRow = {
  key: string; label: string | null; connection_name: string | null;
  invocations: string; cost_cents: string | null; refusals: string; failovers: string;
  touched: string; conversation_cost: string | null;
  conversations: string; sessions: string; flagged: string; auto_flagged: string; continued: string;
  resolved_sessions: string; median_turns: string | null; agent_runs: string; agent_runs_completed: string;
  switched_away: string; left_conversations: string;
};

const num = (v: string | null | undefined): number => Number(v ?? 0);
const rate = (n: number, d: number): number | null => (d > 0 ? n / d : null);
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

export function toQualityMetrics(r: RawQualityRow, sources: QualitySources): AiQualityMetricsDto {
  const invocations = num(r.invocations);
  const refusals = num(r.refusals);
  const failovers = sources.failover ? num(r.failovers) : null;
  const touched = num(r.touched);
  const sessions = num(r.sessions);
  const flagged = num(r.flagged);
  const switchedAway = num(r.switched_away);
  const continued = sources.continuation ? num(r.continued) : null;
  const agentRuns = num(r.agent_runs);
  const agentRunsCompleted = num(r.agent_runs_completed);
  return {
    invocations,
    costCents: num(r.cost_cents),
    refusals,
    refusalRate: invocations === 0 ? 0 : refusals / invocations,
    failovers,
    failoverRate: failovers === null ? null : rate(failovers, invocations),
    conversations: num(r.conversations),
    costPerConversationCents: touched > 0 ? round6(num(r.conversation_cost) / touched) : null,
    sessions,
    flagged,
    autoFlagged: num(r.auto_flagged),
    flagRate: rate(flagged, sessions),
    switchedAway,
    continued,
    // Distinct conversations that switched away or were continued; each is a touched conversation.
    leftRate: rate(num(r.left_conversations), touched),
    resolvedSessions: num(r.resolved_sessions),
    medianTurnsToResolution: r.median_turns === null || r.median_turns === undefined ? null : Math.round(Number(r.median_turns) * 10) / 10,
    agentRuns,
    agentRunsCompleted,
    agentCompletionRate: rate(agentRunsCompleted, agentRuns),
  };
}

export function toQualityRow(r: RawQualityRow, sources: QualitySources): AiQualityRowDto {
  return { key: r.key, label: r.label ?? null, connectionName: r.connection_name ?? null, ...toQualityMetrics(r, sources) };
}

/** A group with no rows (the totals of an empty range; a registry variant with no traffic). */
export const EMPTY_QUALITY_ROW: RawQualityRow = {
  key: 'total', label: null, connection_name: null, invocations: '0', cost_cents: null, refusals: '0', failovers: '0',
  touched: '0', conversation_cost: null, conversations: '0', sessions: '0', flagged: '0', auto_flagged: '0', continued: '0',
  resolved_sessions: '0', median_turns: null, agent_runs: '0', agent_runs_completed: '0', switched_away: '0',
  left_conversations: '0',
};

/**
 * Both reads under one tightened statement_timeout (set_config is
 * transaction-local: the request's withDbAccessContext transaction, or the
 * admin route's system transaction), restored afterwards.
 */
async function withQualityStatementBudget<T>(fn: () => Promise<T>): Promise<T> {
  const tx = db as unknown as { execute(q: unknown): Promise<unknown> };
  const prior = await tightenStatementTimeout(tx, QUALITY_STATEMENT_TIMEOUT_MS);
  let result: T;
  try {
    result = await fn();
  } catch (error) {
    if (errorSqlstate(error) === '57014') throw new QualityQueryTimeoutError();
    throw error;
  }
  if (lockTimeoutWasChanged(prior, QUALITY_STATEMENT_TIMEOUT_MS)) {
    await tx.execute(sql`select set_config('statement_timeout', ${`${prior}ms`}, true)`);
  }
  return result;
}

export async function queryAiQuality(
  input: QualityQueryInput,
  sources: QualitySources = detectQualitySources(),
): Promise<{ rows: AiQualityRowDto[]; totals: AiQualityMetricsDto; sources: AiQualitySourcesDto }> {
  return withQualityStatementBudget(async () => {
    const rows = await db.execute<RawQualityRow>(buildQualityQuery(input, sources));
    const [total] = await db.execute<RawQualityRow>(buildQualityQuery({ ...input, groupBy: 'total' }, sources));
    return {
      rows: [...rows].map((r) => toQualityRow(r, sources)),
      totals: toQualityMetrics(total ?? EMPTY_QUALITY_ROW, sources),
      sources: { failovers: sources.failover, continuations: sources.continuation },
    };
  });
}

export async function queryAiQualityBreakdown(
  input: QualityQueryInput & { groupBy: AiQualityGroupBy },
  sources?: QualitySources,
): Promise<AiQualityBreakdownDto> {
  const result = await queryAiQuality(input, sources);
  return { groupBy: input.groupBy, from: input.from, to: input.to, orgId: input.orgId, ...result };
}
