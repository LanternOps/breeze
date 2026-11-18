/**
 * Keyed platform credit debit client (W03 #7601 Step 8a; #9451).
 *
 * A leaf module: aiCostTracker re-exports it, and the credit-debit outbox
 * (aiCreditDebits.ts) imports it directly, so neither forms an import cycle.
 */
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { organizations } from '../db/schema';

/**
 * Outcome of a KEYED credit debit (W03 #7601 Step 8a; billing-service #25).
 * - `debited`: the billing service holds exactly one debit for the key
 *   (`replayed` = this call found the earlier one).
 * - `retryable`: not confirmed (5xx, 408/429, transport). Retry under the SAME
 *   key — the service dedupes, so a lost response cannot double-charge.
 * - `rejected`: a 4xx (or no partner to bill). The same key can never succeed,
 *   so retrying is pointless; the caller records it for an operator.
 * - `not_configured`: no billing service on this deployment (self-hosted).
 * `code` is short and bounded (`http_<status>[:<error code>]`, `transport`,
 * `org_partner_missing`); it never carries the response message or params.
 */
export type CreditDebitResult =
  | { kind: 'debited'; replayed: boolean }
  | { kind: 'retryable'; status: number | null; code: string }
  | { kind: 'rejected'; status: number | null; code: string }
  | { kind: 'not_configured' };

const CREDIT_DEBIT_TIMEOUT_MS = 15_000;
const BILLING_ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;

export function isBillingServiceConfigured(): boolean {
  return Boolean(process.env.BILLING_SERVICE_URL && process.env.BILLING_SERVICE_API_KEY);
}

async function billingErrorCode(res: Response): Promise<string | null> {
  try {
    const body = await res.json() as { error?: unknown } | null;
    return typeof body?.error === 'string' && BILLING_ERROR_CODE.test(body.error) ? body.error : null;
  } catch {
    return null;
  }
}

/**
 * Debit platform credits under an idempotency key. Never throws for a billing
 * outcome (only for a caller bug: empty key, bad amount), and reports nothing
 * to Sentry itself: the caller owns the durable state and the event.
 *
 * The key travels as BOTH the `idempotencyKey` body field and the
 * `Idempotency-Key` header. The body field name is load-bearing: the billing
 * service's schema strips unknown fields, so a misspelling would silently turn
 * this into an unkeyed debit (pinned by aiCostTracker.test.ts).
 */
export async function debitBillingCredits(
  orgId: string,
  costCents: number,
  opts: { idempotencyKey: string },
): Promise<CreditDebitResult> {
  const key = opts.idempotencyKey;
  if (typeof key !== 'string' || key.trim().length === 0 || key.length > 255) {
    throw new Error('debitBillingCredits: idempotencyKey must be 1-255 characters');
  }
  if (!Number.isFinite(costCents) || costCents < 0) {
    throw new Error('debitBillingCredits: costCents must be a finite non-negative amount');
  }
  const billingUrl = process.env.BILLING_SERVICE_URL;
  const billingKey = process.env.BILLING_SERVICE_API_KEY;
  if (!billingUrl || !billingKey) return { kind: 'not_configured' };

  // Lookup only inside a context; the fetch stays outside it (#1105).
  const [org] = await withSystemDbAccessContext(() => db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1));
  if (!org?.partnerId) return { kind: 'rejected', status: null, code: 'org_partner_missing' };

  let res: Response;
  try {
    res = await fetch(`${billingUrl}/billing/api/internal/partners/${org.partnerId}/ai-credits/deduct`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${billingKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
      },
      body: JSON.stringify({ costCents, idempotencyKey: key }),
      signal: AbortSignal.timeout(CREDIT_DEBIT_TIMEOUT_MS),
    });
  } catch (err) {
    // The stored code stays the bounded 'transport'; the cause (DNS, TLS,
    // timeout abort) goes to the log so a retries_exhausted:transport row is
    // diagnosable. Name + message only: never the request or its headers.
    console.warn('[AI] billing credit debit transport failure', {
      orgId, errorName: err instanceof Error ? err.name : typeof err, error: err instanceof Error ? err.message : String(err),
    });
    return { kind: 'retryable', status: null, code: 'transport' };
  }
  if (res.ok) return { kind: 'debited', replayed: res.headers.get('Idempotent-Replayed') === 'true' };
  const errorCode = await billingErrorCode(res);
  const code = errorCode ? `http_${res.status}:${errorCode}` : `http_${res.status}`;
  // 408/429 mean "try again later" by definition; every other 4xx is a request
  // the same key can never make succeed (bad input, key reused with another
  // amount, auth). 5xx = not confirmed, safe to retry under the same key.
  const retryable = res.status >= 500 || res.status === 408 || res.status === 429;
  return retryable
    ? { kind: 'retryable', status: res.status, code }
    : { kind: 'rejected', status: res.status, code };
}
