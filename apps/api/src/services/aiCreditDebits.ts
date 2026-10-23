/**
 * Operator tooling for platform AI credit debits (#7717 items 1 and 3).
 *
 * Three debit sources, one view:
 *   settlement  reserved token settlements; state on ai_budget_reservations,
 *               key `ai-settlement:<reservation id>`
 *   compute     sandbox compute; ai_credit_debits, key `ai-compute:<run>:<attempt>`
 *   invocation  unreserved token settlements; ai_credit_debits,
 *               key `ai-invocation:<first ledger row id>`
 *
 * A debit the billing service refused (4xx — including every debit sent with a
 * rotated or invalid billing key) or that exhausted its retries is terminal:
 * the sweep never retries it. An operator re-drives it here, and a re-drive
 * NEVER builds a new key or amount: it clears the failure stamp and re-sends
 * the stored key with the stored amount, so the billing service's
 * Idempotency-Key dedupe makes a re-drive of an already-applied debit a no-op
 * replay rather than a second charge.
 */
import { sql, type SQL } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import {
  creditDebitIdempotencyKey,
  replayDeadPendingSettlementRow,
} from './aiBudgetReservations';
import {
  deliverCreditDebit,
  type CreditDebitIntent,
  type CreditDebitOutcome,
} from './aiCreditDebitOutbox';
import { isBillingServiceConfigured } from './aiCreditDebitClient';

/**
 * Thrown by the re-drive verbs when this deployment has no billing service:
 * clearing a failure stamp then would drop the row out of every operator view
 * (no longer failed, and the sweep does not send without a billing service)
 * while nothing was debited.
 */
export class BillingServiceNotConfiguredError extends Error {
  constructor() {
    super('No billing service is configured on this deployment; nothing can be re-driven');
    this.name = 'BillingServiceNotConfiguredError';
  }
}
import { debitSettledCredits } from './aiModels/settleInvocation';

export { listUndeliveredCreditDebits } from './aiCreditDebitOutbox';

export const CREDIT_DEBIT_SOURCES = ['settlement', 'compute', 'invocation'] as const;
export type CreditDebitSourceKind = (typeof CREDIT_DEBIT_SOURCES)[number];

/**
 * Why a debit is stuck, derived from its stored short error code:
 *   auth                 401/403 — a rotated or invalid billing-service key
 *   retries_exhausted    5xx/408/429/transport through every retry
 *   org_partner_missing  no partner to bill
 *   rejected             any other 4xx (bad input, key reused with another amount)
 */
export const CREDIT_DEBIT_FAILURE_CLASSES = ['auth', 'retries_exhausted', 'org_partner_missing', 'rejected'] as const;
export type CreditDebitFailureClass = (typeof CREDIT_DEBIT_FAILURE_CLASSES)[number];

export interface FailedPlatformCreditDebit {
  source: CreditDebitSourceKind;
  /** Reservation id (settlement) or ai_credit_debits id (compute / invocation). */
  id: string;
  orgId: string;
  idempotencyKey: string;
  costCents: number;
  error: string | null;
  failureClass: CreditDebitFailureClass;
  attempts: number;
  failedAt: string;
}

export interface FailedCreditDebitFilter {
  orgId?: string;
  failureClass?: CreditDebitFailureClass;
  /** Inclusive lower / exclusive upper bound on when the debit was stamped failed. */
  failedAfter?: Date;
  failedBefore?: Date;
  limit?: number;
}

export const MAX_FAILED_CREDIT_DEBIT_PAGE = 500;

function rows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] } | null)?.rows ?? []);
}

function inOwnTransaction<T>(label: string, fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn, label));
}

function boundedLimit(limit: number | undefined): number {
  const value = limit ?? 100;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_FAILED_CREDIT_DEBIT_PAGE) {
    throw new Error(`limit must be an integer between 1 and ${MAX_FAILED_CREDIT_DEBIT_PAGE}`);
  }
  return value;
}

/** SQL twin of {@link CreditDebitFailureClass}, over a column holding the stored error code. */
function failureClassSql(errorColumn: SQL): SQL {
  return sql`CASE
    WHEN ${errorColumn} ~ '^http_(401|403)(:|$)' THEN 'auth'
    WHEN ${errorColumn} LIKE 'retries_exhausted:%' THEN 'retries_exhausted'
    WHEN ${errorColumn} = 'org_partner_missing' THEN 'org_partner_missing'
    ELSE 'rejected' END`;
}

/**
 * The union of every terminally failed, still-undebited platform debit, as a
 * subquery with uniform columns. Settlement rows are platform by construction
 * (only platform spend is ever stamped due); outbox rows only exist for it.
 */
function failedDebitsUnion(): SQL {
  return sql`(
    SELECT 'settlement'::text AS source, r.id, r.org_id, r.actual_cost_cents AS cost_cents,
           r.credits_debit_error AS error, r.credits_debit_attempts AS attempts,
           r.credits_debit_failed_at AS failed_at, NULL::text AS idempotency_key,
           ${failureClassSql(sql`r.credits_debit_error`)} AS failure_class
    FROM ai_budget_reservations r
    WHERE r.credits_debit_failed_at IS NOT NULL AND r.credits_debited_at IS NULL
    UNION ALL
    SELECT d.source::text, d.id, d.org_id, d.cost_cents, d.error, d.attempts, d.failed_at,
           d.idempotency_key, ${failureClassSql(sql`d.error`)}
    FROM ai_credit_debits d
    WHERE d.failed_at IS NOT NULL AND d.debited_at IS NULL
  ) f`;
}

function filterSql(filter: FailedCreditDebitFilter): SQL {
  const clauses: SQL[] = [sql`TRUE`];
  if (filter.orgId) clauses.push(sql`f.org_id = ${filter.orgId}::uuid`);
  if (filter.failureClass) clauses.push(sql`f.failure_class = ${filter.failureClass}`);
  if (filter.failedAfter) clauses.push(sql`f.failed_at >= ${filter.failedAfter.toISOString()}::timestamptz`);
  if (filter.failedBefore) clauses.push(sql`f.failed_at < ${filter.failedBefore.toISOString()}::timestamptz`);
  return sql.join(clauses, sql` AND `);
}

type FailedRow = {
  source: CreditDebitSourceKind; id: string; org_id: string; cost_cents: string | number; error: string | null;
  attempts: number; failed_at: string; idempotency_key: string | null; failure_class: CreditDebitFailureClass;
};

async function selectFailed(filter: FailedCreditDebitFilter): Promise<FailedPlatformCreditDebit[]> {
  return rows<FailedRow>(await db.execute(sql`
    SELECT f.source, f.id, f.org_id, f.cost_cents, f.error, f.attempts, f.failed_at::text AS failed_at,
           f.idempotency_key, f.failure_class
    FROM ${failedDebitsUnion()}
    WHERE ${filterSql(filter)}
    ORDER BY f.failed_at DESC, f.id
    LIMIT ${boundedLimit(filter.limit)}
  `)).map((row) => ({
    source: row.source,
    id: row.id,
    orgId: row.org_id,
    idempotencyKey: row.source === 'settlement' ? creditDebitIdempotencyKey(row.id) : row.idempotency_key!,
    costCents: Number(row.cost_cents),
    error: row.error,
    failureClass: row.failure_class,
    attempts: Number(row.attempts),
    failedAt: row.failed_at,
  }));
}

/** Operator view: terminally failed platform debits across every source, newest first. */
export async function listFailedPlatformCreditDebits(filter: FailedCreditDebitFilter = {}): Promise<FailedPlatformCreditDebit[]> {
  return inOwnTransaction('aiCreditDebits.listFailed', () => selectFailed(filter));
}

/**
 * Bulk re-drive: clear the failure stamp (and the retry count) on every
 * matching row, so the sweep re-sends each one under its ORIGINAL key and
 * amount within one interval. Deliberately does not send inline: a bulk
 * re-drive after a key rotation can cover hundreds of rows, and the sweep
 * already paces them. The clears are conditional (still failed, still
 * undebited), so a concurrent re-drive cannot clear a row twice.
 */
export async function requeueFailedCreditDebits(
  filter: FailedCreditDebitFilter & { limit: number },
): Promise<Array<{ source: CreditDebitSourceKind; id: string }>> {
  if (!isBillingServiceConfigured()) throw new BillingServiceNotConfiguredError();
  return inOwnTransaction('aiCreditDebits.requeueFailed', async () => {
    const targets = await selectFailed(filter);
    const settlementIds = targets.filter((t) => t.source === 'settlement').map((t) => t.id);
    const outboxIds = targets.filter((t) => t.source !== 'settlement').map((t) => t.id);
    const requeued: Array<{ source: CreditDebitSourceKind; id: string }> = [];
    if (settlementIds.length > 0) {
      for (const row of rows<{ id: string }>(await db.execute(sql`
        UPDATE ai_budget_reservations
        SET credits_debit_failed_at = NULL, credits_debit_error = NULL, credits_debit_attempts = 0, updated_at = now()
        WHERE id IN (${sql.join(settlementIds.map((id) => sql`${id}::uuid`), sql`, `)})
          AND credits_debit_failed_at IS NOT NULL AND credits_debited_at IS NULL
        RETURNING id
      `))) requeued.push({ source: 'settlement', id: row.id });
    }
    if (outboxIds.length > 0) {
      for (const row of rows<{ id: string; source: CreditDebitSourceKind }>(await db.execute(sql`
        UPDATE ai_credit_debits
        SET failed_at = NULL, error = NULL, attempts = 0, updated_at = now()
        WHERE id IN (${sql.join(outboxIds.map((id) => sql`${id}::uuid`), sql`, `)})
          AND failed_at IS NOT NULL AND debited_at IS NULL
        RETURNING id, source
      `))) requeued.push({ source: row.source, id: row.id });
    }
    return requeued;
  });
}

export interface AiBillingOperatorBacklog {
  failedDebits: number;
  deadSettlements: number;
  /**
   * Outbox debits neither confirmed nor failed an hour after they were owed.
   * Normally the sweep resolves these within minutes; one that lingers is
   * stuck in a way that never advances its retry count (e.g. its bookkeeping
   * keeps failing), so it would otherwise never reach the failed list.
   */
  staleUndeliveredDebits: number;
}

/** Counts behind the sweep's operator-backlog alert (#7717 item 3). */
export async function countAiBillingOperatorBacklog(): Promise<AiBillingOperatorBacklog> {
  return inOwnTransaction('aiCreditDebits.countBacklog', async () => {
    const [row] = rows<{ failed: string | number; dead: string | number; stale: string | number }>(await db.execute(sql`
      SELECT
        (SELECT count(*) FROM ${failedDebitsUnion()}) AS failed,
        (SELECT count(*) FROM ai_budget_reservations
          WHERE pending_settlement_dead_at IS NOT NULL AND pending_settlement IS NOT NULL) AS dead,
        (SELECT count(*) FROM ai_credit_debits
          WHERE debited_at IS NULL AND failed_at IS NULL AND created_at < now() - interval '1 hour') AS stale
    `));
    return {
      failedDebits: Number(row?.failed ?? 0),
      deadSettlements: Number(row?.dead ?? 0),
      staleUndeliveredDebits: Number(row?.stale ?? 0),
    };
  });
}

export type CreditDebitRedrive =
  | { kind: 'not_found' }
  | { kind: 'attempted'; outcome: CreditDebitOutcome };

/**
 * Single re-drive: clear one failed row and send it NOW under its original key
 * and amount, reporting what the billing service said. Refused again → it is
 * re-stamped failed (still listed); a 5xx → counted for the sweep.
 * `not_found` = no such row, or it is not (or no longer) failed.
 */
export async function redriveFailedCreditDebit(target: { source: CreditDebitSourceKind; id: string }): Promise<CreditDebitRedrive> {
  if (!isBillingServiceConfigured()) throw new BillingServiceNotConfiguredError();
  if (target.source === 'settlement') {
    const [row] = await inOwnTransaction('aiCreditDebits.redriveSettlement', async () =>
      rows<{ org_id: string; actual_cost_cents: string | number }>(await db.execute(sql`
        UPDATE ai_budget_reservations
        SET credits_debit_failed_at = NULL, credits_debit_error = NULL, credits_debit_attempts = 0, updated_at = now()
        WHERE id = ${target.id}::uuid AND credits_debit_failed_at IS NOT NULL AND credits_debited_at IS NULL
          AND status = 'settled' AND actual_cost_cents > 0
        RETURNING org_id, actual_cost_cents
      `)));
    if (!row) return { kind: 'not_found' };
    const outcome = await debitSettledCredits({
      orgId: row.org_id, reservationId: target.id, costCents: Number(row.actual_cost_cents),
    });
    return { kind: 'attempted', outcome };
  }

  const [row] = await inOwnTransaction('aiCreditDebits.redriveOutbox', async () =>
    rows<{ id: string; org_id: string; source: CreditDebitIntent['source']; idempotency_key: string; cost_cents: string | number }>(await db.execute(sql`
      UPDATE ai_credit_debits
      SET failed_at = NULL, error = NULL, attempts = 0, updated_at = now()
      WHERE id = ${target.id}::uuid AND source = ${target.source}
        AND failed_at IS NOT NULL AND debited_at IS NULL
      RETURNING id, org_id, source, idempotency_key, cost_cents
    `)));
  if (!row) return { kind: 'not_found' };
  const outcome = await deliverCreditDebit({
    id: row.id, orgId: row.org_id, source: row.source, idempotencyKey: row.idempotency_key, costCents: Number(row.cost_cents),
  });
  return { kind: 'attempted', outcome };
}

export type DeadSettlementReplay =
  | { kind: 'not_found' }
  | { kind: 'superseded' }
  | { kind: 'failed'; error: string }
  | { kind: 'replayed'; settlement: 'settled' | 'already_settled'; debit: CreditDebitOutcome | null };

/**
 * Replay one dead pending settlement (#7717 item 3) and, when that call is
 * the one that settled platform spend, debit it under the reservation's own
 * `ai-settlement:<id>` key — the same key every other attempt would use.
 */
export async function replayDeadPendingSettlement(reservationId: string): Promise<DeadSettlementReplay> {
  const replay = await replayDeadPendingSettlementRow(reservationId);
  if (replay.kind !== 'replayed') return replay;
  const { result } = replay;
  const debit = result.kind === 'settled' && result.creditsDebitDue
    ? await debitSettledCredits({ orgId: replay.orgId, reservationId: result.reservationId, costCents: result.actualCostCents })
    : null;
  return { kind: 'replayed', settlement: result.kind, debit };
}
