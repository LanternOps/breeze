/**
 * The monthly close (#7608): turn one org's chargeable, authoritative,
 * unclaimed ledger rows written before the end of UTC month P into
 * ai_usage_charges, exactly once.
 *
 * Idempotency, by layer:
 *   1. ai_usage_charge_runs UNIQUE (org_id, period_start), claimed ON CONFLICT
 *      DO NOTHING as the FIRST write (contract_billing_periods precedent): a
 *      concurrent closer blocks on the unique slot and then skips.
 *   2. ai_usage_charge_claims PK (invocation_id): an invocation can be claimed
 *      once, ever. The claim INSERT must claim exactly the aggregated rows, or
 *      ChargeRunConflictError rolls the WHOLE run back (run row included), and
 *      the next sweep retries cleanly.
 * Stragglers (rows whose month already closed for this org — e.g. moved in by
 * an org merge) are picked up by the NEXT run as their own charge rows, with
 * usage_period_start < period_start, and are invoiced as a labelled "usage
 * from {month}" line. Rows older than the 92-day lookback are left unbilled
 * (counted in the log).
 *
 * Money (W10 rounding rules): amounts are the STAMPED charge_amount values
 * (never the current card); SUM is exact numeric (RR3); each charge rounds once
 * with roundToCurrency (RR4); a priced charge rounding to 0 is 'no_charge'.
 *
 * SYSTEM CONTEXT, ONE TRANSACTION: callers wrap it in
 * runOutsideDbContext(() => withSystemDbAccessContext(...)). It never takes
 * the organizations row lock (settlement's SELECT … FOR UPDATE) and reads the
 * org row without locking it. Its inserts' FK checks do take FOR KEY SHARE on
 * that row until commit, which a concurrent admission/settlement FOR UPDATE for
 * the same org waits behind — bounded by this one org's close, which is why
 * the close stays a single short per-org transaction.
 */
import { sql } from 'drizzle-orm';
import { roundToCurrency } from '@breeze/shared';
import { db, getCurrentDbAccessContext } from '../../db';
import { extractRowCount } from '../../db/rowCount';
import { CHARGEBACK_LOOKBACK_DAYS, isPeriodClosed, lookbackStartIso, monthPeriod, utcStartIso, type ChargePeriod } from './chargePeriods';

export class ChargeRunConflictError extends Error {
  constructor(message: string) { super(message); this.name = 'ChargeRunConflictError'; }
}

export type ChargeRunResult =
  | { kind: 'charged'; runId: string; chargeCount: number; invocationCount: number;
      unpricedInvocationCount: number; lateInvocationCount: number; expiredInvocationCount: number }
  | { kind: 'skipped'; reason: 'already_run' | 'period_open' | 'org_not_found' };

type GroupRow = {
  usage_period_start: string; currency_code: string; served_model: string; priced: boolean;
  invocation_count: number; input_tokens: string; output_tokens: string;
  cache_read_tokens: string; cache_write_tokens: string; amount_exact: string | null;
};

function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? (result as T[]));
}

/** The ONE candidate predicate, shared by the aggregate and the claim. */
function candidates(orgId: string, period: ChargePeriod) {
  return sql`i.org_id = ${orgId}::uuid
    AND i.chargeable
    AND i.ledger_mode = 'authoritative'
    AND i.created_at >= ${lookbackStartIso(period)}::timestamptz
    AND i.created_at < ${utcStartIso(period.periodEnd)}::timestamptz
    AND NOT EXISTS (SELECT 1 FROM ai_usage_charge_claims c WHERE c.invocation_id = i.id)`;
}

const USAGE_MONTH = sql`date_trunc('month', i.created_at AT TIME ZONE 'UTC')::date`;

export async function runOrgChargePeriod(input: { orgId: string; periodStart: string; now?: Date }): Promise<ChargeRunResult> {
  if (getCurrentDbAccessContext()?.scope !== 'system') {
    throw new Error('runOrgChargePeriod must run inside a system DB context');
  }
  const period = monthPeriod(input.periodStart);
  if (!isPeriodClosed(period, input.now ?? new Date())) return { kind: 'skipped', reason: 'period_open' };

  const [org] = rowsOf<{ partner_id: string }>(await db.execute(sql`
    SELECT partner_id FROM organizations WHERE id = ${input.orgId}::uuid`));
  if (!org) return { kind: 'skipped', reason: 'org_not_found' };

  // 1. The (org, month) claim — first write, so a concurrent closer waits here.
  const [run] = rowsOf<{ id: string }>(await db.execute(sql`
    INSERT INTO ai_usage_charge_runs (org_id, partner_id, period_start, period_end)
    VALUES (${input.orgId}::uuid, ${org.partner_id}::uuid, ${period.periodStart}::date, ${period.periodEnd}::date)
    ON CONFLICT (org_id, period_start) DO NOTHING
    RETURNING id`));
  if (!run) return { kind: 'skipped', reason: 'already_run' };

  // 2. Freeze ONE candidate set for this run (Codex review finding 5): the
  //    aggregate and the claim both read this temp table, so they process the
  //    identical invocation ids by construction. Temp tables carry no RLS and
  //    die at commit/rollback (one per transaction: the sweep runs each org in
  //    its own transaction).
  await db.execute(sql`
    CREATE TEMP TABLE ai_charge_candidates ON COMMIT DROP AS
    SELECT i.id, i.org_id, ${USAGE_MONTH} AS usage_period_start, i.charge_currency AS currency_code,
           i.served_model, (i.charge_amount IS NOT NULL) AS priced,
           i.input_tokens, i.output_tokens, i.cache_read_tokens, i.cache_write_tokens, i.charge_amount
    FROM ai_invocations i
    WHERE ${candidates(input.orgId, period)}`);

  // 3. Aggregate the frozen set (exact numeric SUM — RR3).
  const groups = rowsOf<GroupRow>(await db.execute(sql`
    SELECT to_char(c.usage_period_start, 'YYYY-MM-DD') AS usage_period_start,
           c.currency_code, c.served_model, c.priced,
           count(*)::int AS invocation_count,
           COALESCE(sum(c.input_tokens), 0)::text AS input_tokens,
           COALESCE(sum(c.output_tokens), 0)::text AS output_tokens,
           COALESCE(sum(c.cache_read_tokens), 0)::text AS cache_read_tokens,
           COALESCE(sum(c.cache_write_tokens), 0)::text AS cache_write_tokens,
           sum(c.charge_amount)::numeric(20, 6)::text AS amount_exact
    FROM ai_charge_candidates c
    GROUP BY 1, 2, 3, 4
    ORDER BY 1, 2, 3, 4`));

  // Snapshot a human label per model now; it prints on the line.
  const models = [...new Set(groups.map((g) => g.served_model))];
  const labels = new Map<string, string>();
  if (models.length) {
    const found = rowsOf<{ model_id: string; display_name: string | null }>(await db.execute(sql`
      SELECT model_id, display_name FROM ai_platform_models
      WHERE model_id IN (${sql.join(models.map((m) => sql`${m}`), sql`, `)})`));
    for (const f of found) if (f.display_name) labels.set(f.model_id, f.display_name);
  }

  // 4. One charge row per group; round once per charge (RR4).
  let expected = 0;
  let unpriced = 0;
  let late = 0;
  for (const g of groups) {
    expected += g.invocation_count;
    if (!g.priced) unpriced += g.invocation_count;
    if (g.usage_period_start < period.periodStart) late += g.invocation_count;
    const amount = g.priced ? roundToCurrency(g.amount_exact!, g.currency_code) : null;
    // roundToCurrency returns exactly '0.00' for zero in EVERY currency (its
    // formatMinor short-circuits 0n, JPY included), so this string compare is
    // the whole "rounds to nothing" test — never a $0 line (RR4).
    const status = !g.priced ? 'unpriced' : amount === '0.00' ? 'no_charge' : 'not_billed';
    await db.execute(sql`
      INSERT INTO ai_usage_charges (org_id, partner_id, run_id, period_start, period_end, usage_period_start,
        currency_code, served_model, model_label, priced, invocation_count, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, amount_exact, amount, billing_status)
      VALUES (${input.orgId}::uuid, ${org.partner_id}::uuid, ${run.id}::uuid, ${period.periodStart}::date,
        ${period.periodEnd}::date, ${g.usage_period_start}::date, ${g.currency_code}, ${g.served_model},
        ${labels.get(g.served_model) ?? g.served_model}, ${g.priced}, ${g.invocation_count},
        ${g.input_tokens}::bigint, ${g.output_tokens}::bigint, ${g.cache_read_tokens}::bigint,
        ${g.cache_write_tokens}::bigint, ${g.amount_exact}::numeric, ${amount}::numeric, ${status})`);
  }

  // 5. Claim exactly the frozen ids, each into its charge. ON CONFLICT skips an id
  //    another closer claimed after we froze it; the count check then rolls back.
  const claimed = extractRowCount(await db.execute(sql`
    INSERT INTO ai_usage_charge_claims (invocation_id, org_id, run_id, charge_id)
    SELECT c.id, c.org_id, ${run.id}::uuid, ch.id
    FROM ai_charge_candidates c
    JOIN ai_usage_charges ch
      ON ch.run_id = ${run.id}::uuid
     AND ch.usage_period_start = c.usage_period_start
     AND ch.currency_code = c.currency_code
     AND ch.served_model = c.served_model
     AND ch.priced = c.priced
    ON CONFLICT (invocation_id) DO NOTHING`));
  if (claimed !== expected) {
    throw new ChargeRunConflictError(
      `AI chargeback close for org ${input.orgId} ${period.periodStart}: aggregated ${expected} rows but claimed ${claimed}; rolled back for retry`);
  }

  await db.execute(sql`
    UPDATE ai_usage_charge_runs
    SET invocation_count = ${expected}, charge_count = ${groups.length},
        unpriced_invocation_count = ${unpriced}, late_invocation_count = ${late}, completed_at = now()
    WHERE id = ${run.id}::uuid`);

  // 6. Rows that aged past the lookback unclaimed are never billed — count and
  //    say so (Codex review finding 13), never silently.
  const [expiredRow] = rowsOf<{ n: number }>(await db.execute(sql`
    SELECT count(*)::int AS n FROM ai_invocations i
    WHERE i.org_id = ${input.orgId}::uuid AND i.chargeable AND i.ledger_mode = 'authoritative'
      AND i.created_at < ${lookbackStartIso(period)}::timestamptz
      AND NOT EXISTS (SELECT 1 FROM ai_usage_charge_claims c WHERE c.invocation_id = i.id)`));
  const expired = expiredRow?.n ?? 0;
  if (expired > 0) {
    console.warn(`[AiChargeback] org ${input.orgId}: ${expired} chargeable row(s) older than the ${CHARGEBACK_LOOKBACK_DAYS}-day lookback were never closed and will not be billed`);
  }

  return { kind: 'charged', runId: run.id, chargeCount: groups.length, invocationCount: expected,
    unpricedInvocationCount: unpriced, lateInvocationCount: late, expiredInvocationCount: expired };
}
