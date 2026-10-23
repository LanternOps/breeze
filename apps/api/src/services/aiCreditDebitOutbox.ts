/**
 * Durable keyed platform credit debits with no budget reservation (#9451,
 * #7717 item 2): sandbox compute and unreserved token settlements.
 *
 * Reserved token settlements keep their debit state on the reservation row
 * (aiBudgetReservations.ts, `ai-settlement:<id>`). Everything else used to be
 * fire-and-forget: compute went through an UNKEYED deduct and an unreserved
 * token debit failure was only logged. Both now write an `ai_credit_debits`
 * row in the SAME transaction as the spend they bill, so the obligation can
 * never be lost, then deliver it:
 *
 *   debited                  → stamped `debited_at`
 *   4xx / no partner         → stamped `failed_at` (terminal, operator re-drive)
 *   5xx / 408 / 429 / network → counted; the sweep retries it under the SAME key
 *                              and amount until MAX_CREDIT_DEBIT_ATTEMPTS
 *
 * Every send re-reads nothing: the key and amount travel from the row as first
 * written. The billing service dedupes on the key and 409s a key reused with
 * another amount, so a retry, a concurrent sweep or an operator re-drive can
 * never double-charge.
 *
 * Every helper opens its own short system transaction (or runs inside the
 * caller's, for the insert), and the HTTP call always runs outside one: a
 * pooled connection must never be held across a network call (#1105).
 */
import { sql, type SQL } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { debitBillingCredits, isBillingServiceConfigured } from './aiCreditDebitClient';
import { safeErrorMessage } from './aiModels/safeDbError';
import { captureException, captureMessage } from './sentry';

export type CreditDebitSource = 'compute' | 'invocation';

/** What one delivery attempt did, for callers that report it (operator re-drive). */
export type CreditDebitOutcome =
  | 'debited'
  | 'not_configured'
  | 'rejected'
  | 'retry_scheduled'
  | 'retries_exhausted'
  | 'bookkeeping_failed';

export interface CreditDebitIntent {
  id: string;
  orgId: string;
  source: CreditDebitSource;
  idempotencyKey: string;
  /** Exactly as first written; every re-send uses this amount. */
  costCents: number;
}

/**
 * Retryable attempts before a debit is stamped failed, and the grace before
 * the sweep retries one the settling call may still be making. Same values as
 * reservation debits (aiBudgetReservations.ts), deliberately: one retry policy.
 */
export const MAX_OUTBOX_DEBIT_ATTEMPTS = 24;
export const OUTBOX_DEBIT_SWEEP_GRACE_SECONDS = 120;

/**
 * Compute: one settlement per run ATTEMPT. `queued_at` is the attempt
 * identity: the enqueue_failed reclaim re-stamps it (and clears the claim)
 * when it reuses the run row for a new attempt, so a reclaimed run cannot
 * collide with — or be suppressed by — its earlier attempt's key.
 * Microseconds, so the key is exact for the timestamptz it came from.
 */
export function computeDebitKeySql(): SQL {
  // Bare column names: valid only in a statement over ai_agent_runs (the
  // settlement claim's UPDATE ... RETURNING).
  return sql.raw(`'ai-compute:' || id::text || ':' || (extract(epoch from queued_at) * 1000000)::bigint::text`);
}

/** Unreserved token settlement: keyed by the settlement's first ledger row. */
export function invocationDebitIdempotencyKey(firstInvocationId: string): string {
  return `ai-invocation:${firstInvocationId}`;
}

function rows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] } | null)?.rows ?? []);
}

function inOwnTransaction<T>(label: string, fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn, label));
}

function boundedCode(code: string): string {
  return code.slice(0, 128);
}

type IntentRow = { id: string; org_id: string; source: CreditDebitSource; idempotency_key: string; cost_cents: string | number };

function toIntent(row: IntentRow): CreditDebitIntent {
  return {
    id: row.id,
    orgId: row.org_id,
    source: row.source,
    idempotencyKey: row.idempotency_key,
    costCents: Number(row.cost_cents),
  };
}

/**
 * Record a debit obligation. MUST run inside the caller's system-context
 * transaction, so the intent commits (or rolls back) with the spend it bills.
 * Returns null when the key already exists (that spend's debit is already
 * owed, or paid, under it, and nothing new may be sent), or when this
 * deployment has no billing service.
 */
export async function insertCreditDebitIntent(input: {
  orgId: string;
  source: CreditDebitSource;
  sourceId: string;
  idempotencyKey: string;
  costCents: number | string;
}): Promise<CreditDebitIntent | null> {
  // No billing service (self-hosted): there is nobody to owe, and an
  // undeliverable row would only pile up — or worse, replay as real debits the
  // day one is configured. Same posture as before #9451 (the deduct no-op'd).
  if (!isBillingServiceConfigured()) return null;
  const [row] = rows<IntentRow>(await db.execute(sql`
    INSERT INTO ai_credit_debits (org_id, source, source_id, idempotency_key, cost_cents)
    VALUES (${input.orgId}::uuid, ${input.source}, ${input.sourceId}::uuid, ${input.idempotencyKey}, ${String(input.costCents)}::numeric)
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id, org_id, source, idempotency_key, cost_cents
  `));
  return row ? toIntent(row) : null;
}

async function markDebited(id: string): Promise<void> {
  await inOwnTransaction('aiCreditDebits.markDebited', async () => {
    // Success dominates: a confirmed debit clears a failure stamped by a
    // concurrent attempt that lost its response.
    await db.execute(sql`
      UPDATE ai_credit_debits
      SET debited_at = now(), failed_at = NULL, error = NULL, updated_at = now()
      WHERE id = ${id}::uuid AND debited_at IS NULL
      RETURNING id
    `);
  });
}

async function recordFailure(id: string, code: string): Promise<void> {
  await inOwnTransaction('aiCreditDebits.recordFailure', async () => {
    await db.execute(sql`
      UPDATE ai_credit_debits
      SET failed_at = now(), error = ${boundedCode(code)}, attempts = attempts + 1, updated_at = now()
      WHERE id = ${id}::uuid AND debited_at IS NULL AND failed_at IS NULL
      RETURNING id
    `);
  });
}

async function recordRetry(id: string, code: string): Promise<{ attempts: number; exhausted: boolean }> {
  return inOwnTransaction('aiCreditDebits.recordRetry', async () => {
    const [row] = rows<{ attempts: number; exhausted: boolean }>(await db.execute(sql`
      UPDATE ai_credit_debits
      SET attempts = attempts + 1,
          error = CASE WHEN attempts + 1 >= ${MAX_OUTBOX_DEBIT_ATTEMPTS}
            THEN ${boundedCode(`retries_exhausted:${code}`)} ELSE ${boundedCode(code)} END,
          failed_at = CASE WHEN attempts + 1 >= ${MAX_OUTBOX_DEBIT_ATTEMPTS} THEN now() ELSE NULL END,
          updated_at = now()
      WHERE id = ${id}::uuid AND debited_at IS NULL AND failed_at IS NULL
      RETURNING attempts, failed_at IS NOT NULL AS exhausted
    `));
    return row ? { attempts: Number(row.attempts), exhausted: row.exhausted === true } : { attempts: 0, exhausted: false };
  });
}

// Same storm posture as settleInvocation's reporter: a rotated billing key
// rejects every debit, so Sentry gets one event per code per org per window
// per process; every occurrence still reaches the server log with its ids.
const REPORT_WINDOW_MS = 60 * 60 * 1000;
const MAX_THROTTLE_KEYS = 10_000;
const lastReportedAt = new Map<string, number>();

function shouldReport(eventCode: string, orgId: string): boolean {
  const now = Date.now();
  const key = `${eventCode}:${orgId}`;
  const last = lastReportedAt.get(key);
  if (last !== undefined && now - last < REPORT_WINDOW_MS) return false;
  if (lastReportedAt.size >= MAX_THROTTLE_KEYS) lastReportedAt.clear();
  lastReportedAt.set(key, now);
  return true;
}

export function __resetCreditDebitOutboxReportsForTests(): void {
  lastReportedAt.clear();
}

function billingTags(intent: CreditDebitIntent, status: number | null): Record<string, string> {
  return {
    org_id: intent.orgId,
    ai_credit_debit_id: intent.id,
    ai_credit_debit_source: intent.source,
    ai_billing_http_status: status === null ? 'none' : String(status),
  };
}

/**
 * Send one owed debit under its stored key and amount and record the outcome
 * durably. Never throws: the spend already happened and is recorded; a
 * bookkeeping failure leaves the row for the sweep.
 */
export async function deliverCreditDebit(intent: CreditDebitIntent): Promise<CreditDebitOutcome> {
  const ref = { orgId: intent.orgId, debitId: intent.id, source: intent.source, idempotencyKey: intent.idempotencyKey, costCents: intent.costCents };
  try {
    const result = await debitBillingCredits(intent.orgId, intent.costCents, { idempotencyKey: intent.idempotencyKey });
    switch (result.kind) {
      case 'debited':
        await markDebited(intent.id);
        return 'debited';
      case 'not_configured':
        return 'not_configured';
      case 'rejected':
        await recordFailure(intent.id, result.code);
        console.error('[AI] platform credit debit REJECTED; stamped failed for an operator', { ...ref, code: result.code });
        if (shouldReport('ai_credit_debit_rejected', intent.orgId)) {
          captureMessage('AI platform credit debit rejected; spend not debited', {
            eventCode: 'ai_credit_debit_rejected', tags: billingTags(intent, result.status),
          });
        }
        return 'rejected';
      case 'retryable': {
        const { attempts, exhausted } = await recordRetry(intent.id, result.code);
        console.warn('[AI] platform credit debit not confirmed; the sweep retries it under the same key', {
          ...ref, code: result.code, attempts, exhausted,
        });
        if (exhausted && shouldReport('ai_credit_debit_retries_exhausted', intent.orgId)) {
          captureMessage('AI platform credit debit never confirmed; retries exhausted', {
            eventCode: 'ai_credit_debit_retries_exhausted', tags: billingTags(intent, result.status),
          });
        }
        return exhausted ? 'retries_exhausted' : 'retry_scheduled';
      }
    }
  } catch (error) {
    const message = safeErrorMessage(error);
    console.error('[AI] platform credit debit bookkeeping failed; the sweep retries it', { ...ref, error: message });
    captureException(new Error(`AI credit debit bookkeeping failed: ${message}`), undefined, {
      org_id: intent.orgId, ai_credit_debit_source: intent.source,
    });
    return 'bookkeeping_failed';
  }
}

/**
 * Owed debits not yet confirmed: not debited, not failed, and older than the
 * settling call's own grace. Failed rows are EXCLUDED so a terminal refusal
 * never loops; an operator re-queues them.
 */
export async function listUndeliveredCreditDebits(limit = 100): Promise<CreditDebitIntent[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('limit must be a positive safe integer');
  return inOwnTransaction('aiCreditDebits.listUndelivered', async () =>
    rows<IntentRow>(await db.execute(sql`
      SELECT id, org_id, source, idempotency_key, cost_cents FROM ai_credit_debits
      WHERE debited_at IS NULL AND failed_at IS NULL
        AND created_at < now() - make_interval(secs => ${OUTBOX_DEBIT_SWEEP_GRACE_SECONDS})
      ORDER BY created_at ASC
      LIMIT ${limit}
    `)).map(toIntent));
}

/** Sweep leg: retry every undelivered debit once. Returns how many were attempted. */
export async function retryUndeliveredCreditDebits(limit = 100): Promise<number> {
  if (!isBillingServiceConfigured()) return 0;
  const due = await listUndeliveredCreditDebits(limit);
  for (const intent of due) await deliverCreditDebit(intent);
  return due.length;
}
