/**
 * AI usage breakdowns from the invocation ledger (spec §5.5, §11). Runs in the
 * request DB context: ai_invocations is shape-1 RLS, so a partner token sees
 * only its orgs. The caller's accessible org list is ALSO applied in SQL
 * (defence in depth, and the scoping is then visible in unit tests).
 *
 * Counts authoritative rows only (W02 shadow rows were never billed).
 *
 * groupBy=model groups by the model that SERVED each ledger leg
 * (funding_source, connection_id, served_model) — not by offering_id: W03's
 * settleInvocation writes the BOUND offering's id on every leg, including a
 * leg served by a refusal fallback model, so offering_id would charge the
 * fallback model's spend to the refused model.
 *
 * Refusals = rows with stop_reason = 'refusal'. Caveat (W03 settleInvocation):
 * a refused turn served by a fallback writes two rows (refused leg +
 * fallback_used leg) and the refused leg gets stop_reason 'refusal'; a turn
 * with a single priced leg carries the provider's own stop reason (also
 * 'refusal' when the provider declined). So refusalRate is "declined calls per
 * model call", not per turn.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { AiUsageBreakdownDto, AiUsageGroupBy, AiUsageRowDto } from '@breeze/shared';
import { db } from '../../db';

export interface UsageQueryInput {
  groupBy: AiUsageGroupBy;
  /** Inclusive UTC dates (YYYY-MM-DD). */
  from: string;
  to: string;
  /** Optional single-org filter (already access-checked by the route). */
  orgId: string | null;
  /** The caller's reach: null = unrestricted (system scope). */
  accessibleOrgIds: string[] | null;
}

function nextDayIso(date: string): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

function orgScope(accessibleOrgIds: string[] | null): SQL {
  if (accessibleOrgIds === null) return sql``;
  if (accessibleOrgIds.length === 0) return sql`AND false`;
  return sql`AND i.org_id IN (${sql.join(accessibleOrgIds.map((id) => sql`${id}::uuid`), sql`, `)})`;
}

/** The ledger scope every AI-usage read shares (spend here, quality in qualityQueries.ts). */
export type LedgerScopeInput = Pick<UsageQueryInput, 'from' | 'to' | 'orgId' | 'accessibleOrgIds'>;

export function ledgerWhere(input: LedgerScopeInput): SQL {
  return sql`i.ledger_mode = 'authoritative'
    AND i.created_at >= ${`${input.from}T00:00:00.000Z`}::timestamptz
    AND i.created_at < ${nextDayIso(input.to)}::timestamptz
    ${input.orgId ? sql`AND i.org_id = ${input.orgId}::uuid` : sql``}
    ${orgScope(input.accessibleOrgIds)}`;
}

const AGGREGATES = sql`
  COUNT(*)::text AS invocations,
  SUM(i.cost_cents)::text AS cost_cents,
  SUM(i.input_tokens + i.cache_read_tokens + i.cache_write_tokens)::text AS input_tokens,
  SUM(i.output_tokens)::text AS output_tokens,
  COUNT(*) FILTER (WHERE i.stop_reason = 'refusal')::text AS refusals,
  COUNT(*) FILTER (WHERE i.fallback_used)::text AS fallbacks`;

const ORDER_AND_LIMIT = sql`ORDER BY SUM(i.cost_cents) DESC NULLS LAST, COUNT(*) DESC
    LIMIT 200`;

/**
 * Non-model groupings: one pass over the ledger. A user the caller cannot see
 * (or a deleted one) has no name → label NULL → the row shows its key (id);
 * only a NULL user_id is 'system'.
 */
const SIMPLE: Record<Exclude<AiUsageGroupBy, 'model'>, { key: SQL; label: SQL; join: SQL }> = {
  surface: { key: sql`i.surface`, label: sql`MIN(i.surface)`, join: sql`` },
  user: {
    key: sql`COALESCE(i.user_id::text, 'system')`,
    label: sql`MIN(CASE WHEN i.user_id IS NULL THEN 'system' ELSE u.name END)`,
    join: sql`LEFT JOIN users u ON u.id = i.user_id`,
  },
  org: { key: sql`i.org_id::text`, label: sql`MIN(o.name)`, join: sql`LEFT JOIN organizations o ON o.id = i.org_id` },
};

/**
 * groupBy=model: aggregate per served model first (so the label lookup runs
 * once per group, not per ledger row), then label it:
 *  - a connection leg: the offering on THAT connection whose model id is the
 *    served (or, failing that, the requested) model;
 *  - a platform leg: the platform catalog's display name for the served model;
 *  - else the served model id.
 * The key keeps funding and connection apart, so the same model id on the
 * platform key and on a BYO key stays two rows. connection_disconnected marks
 * a connection W03 has soft-disconnected (kept as ledger provenance; a
 * reconnect is a NEW connection, so its calls are a separate row); false for
 * platform legs.
 */
function buildModelQuery(input: UsageQueryInput): SQL {
  return sql`
    SELECT g.funding_source || ':' || COALESCE(g.connection_id::text, 'platform') || ':' || g.served_model AS key,
      COALESCE(ml.name, spm.display_name, g.served_model) AS label,
      g.invocations, g.cost_cents, g.input_tokens, g.output_tokens, g.refusals, g.fallbacks,
      COALESCE(gc.status = 'disconnected', false) AS connection_disconnected
    FROM (
      SELECT i.funding_source, i.connection_id, i.served_model, MIN(i.requested_model) AS requested_model,
        ${AGGREGATES},
        SUM(i.cost_cents) AS sort_cost, COUNT(*) AS sort_count
      FROM ai_invocations i
      WHERE ${ledgerWhere(input)}
      GROUP BY i.funding_source, i.connection_id, i.served_model
      ORDER BY SUM(i.cost_cents) DESC NULLS LAST, COUNT(*) DESC
      LIMIT 200
    ) g
    LEFT JOIN LATERAL (
      SELECT COALESCE(m.display_name, m.model_id) AS name
      FROM partner_ai_models m
      WHERE g.connection_id IS NOT NULL
        AND m.connection_id = g.connection_id
        AND m.model_id IN (g.served_model, g.requested_model)
      ORDER BY (m.model_id = g.served_model) DESC
      LIMIT 1
    ) ml ON true
    LEFT JOIN ai_platform_models spm ON g.connection_id IS NULL AND spm.model_id = g.served_model
    LEFT JOIN partner_ai_connections gc ON gc.id = g.connection_id
    ORDER BY g.sort_cost DESC NULLS LAST, g.sort_count DESC`;
}

export function buildUsageQuery(input: UsageQueryInput): SQL {
  if (input.groupBy === 'model') return buildModelQuery(input);
  const g = SIMPLE[input.groupBy];
  return sql`
    SELECT ${g.key} AS key, ${g.label} AS label, ${AGGREGATES}
    FROM ai_invocations i
    ${g.join}
    WHERE ${ledgerWhere(input)}
    GROUP BY 1
    ${ORDER_AND_LIMIT}`;
}

type RawRow = {
  key?: string; label?: string | null; invocations: string; cost_cents: string | null;
  input_tokens: string | null; output_tokens: string | null; refusals: string; fallbacks: string;
  /** groupBy=model only. */
  connection_disconnected?: boolean;
};

export function toUsageRow(r: RawRow): AiUsageRowDto {
  const invocations = Number(r.invocations ?? 0);
  const refusals = Number(r.refusals ?? 0);
  return {
    key: r.key ?? '',
    label: r.label ?? r.key ?? '',
    invocations,
    costCents: Number(r.cost_cents ?? 0),
    inputTokens: Number(r.input_tokens ?? 0),
    outputTokens: Number(r.output_tokens ?? 0),
    refusals,
    refusalRate: invocations === 0 ? 0 : refusals / invocations,
    fallbacks: Number(r.fallbacks ?? 0),
    ...(r.connection_disconnected === undefined ? {} : { connectionDisconnected: r.connection_disconnected === true }),
  };
}

/** The first of the current UTC month through today (inclusive). */
export function defaultUsageRange(now: Date = new Date()): { from: string; to: string } {
  const to = now.toISOString().slice(0, 10);
  return { from: `${to.slice(0, 8)}01`, to };
}

const EMPTY: RawRow = { invocations: '0', cost_cents: null, input_tokens: null, output_tokens: null, refusals: '0', fallbacks: '0' };

export async function queryAiUsageBreakdown(input: UsageQueryInput): Promise<AiUsageBreakdownDto> {
  const rows = await db.execute<RawRow>(buildUsageQuery(input));
  const [total] = await db.execute<RawRow>(sql`SELECT ${AGGREGATES} FROM ai_invocations i WHERE ${ledgerWhere(input)}`);
  const { key: _k, label: _l, ...totals } = toUsageRow(total ?? EMPTY);
  return { groupBy: input.groupBy, from: input.from, to: input.to, orgId: input.orgId, rows: [...rows].map(toUsageRow), totals };
}
