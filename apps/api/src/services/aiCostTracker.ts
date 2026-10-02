/**
 * AI Cost Tracker
 *
 * Budget, rate-limit and billing-credit gates, compute (sandbox) cost, and
 * usage summaries. Token cost is NOT recorded here: every model call is
 * priced and written by aiModels/settleInvocation.ts (W03 #7601).
 */

import { db, withSystemDbAccessContext } from '../db';
import { aiSessions, aiCostUsage, aiBudgets, organizations } from '../db/schema';
import { aiAgentRuns } from '../db/schema/aiAgents';
import { eq, and, sql, desc, isNotNull } from 'drizzle-orm';
import { getRedis } from './redis';
import { rateLimiter } from './rate-limit';
import { getEffectiveAiBudget } from './effectiveSettings';
import { captureException, captureMessage } from './sentry';
import { captureAtMostHourly } from './llm/platformKeyAlert';
import { evaluateAiBudgetThresholds } from './aiBudgetAlerts';
import { getCatalogEntryName } from './llmProviderCatalog';
import { topologySessionCondition, type TopologySessionVisibility } from './topology/aiSessionAccess';

export type AiBillingSource = 'platform' | 'partner_key';

export interface CatalogPricingSnapshot {
  catalogEntryId: string;
  revisionId: string;
  inputCentsPerM: number;
  outputCentsPerM: number;
  cacheReadCentsPerM: number;
  cacheWriteCentsPerM: number;
}

/**
 * Why an org was refused AI spend.
 *
 * The split that matters to a retrying caller is `permanent`, not the reason
 * label: a daily/monthly cap rolls over and prepaid credits can be topped up,
 * while an org with AI switched off — or a partner on a plan that has no AI —
 * stays refused until a human changes something. Collapsing both into one
 * retryable shape is what let a tenant's own "AI off" setting burn every
 * workspace ingest attempt and stall indexing behind it.
 */
export type AiDenialReason =
  | 'plan_gate'
  | 'credits_exhausted'
  | 'ai_disabled'
  | 'daily_budget'
  | 'monthly_budget';

export interface AiAccessDenial {
  /** The user-facing message; identical to what the legacy string API returns. */
  message: string;
  reason: AiDenialReason;
  /** True when retrying cannot clear it — only a config/plan/budget change can. */
  permanent: boolean;
}

const PERMANENT_DENIAL_REASONS: ReadonlySet<AiDenialReason> = new Set<AiDenialReason>([
  'plan_gate',
  'ai_disabled',
]);

function denial(reason: AiDenialReason, message: string): AiAccessDenial {
  return { message, reason, permanent: PERMANENT_DENIAL_REASONS.has(reason) };
}

// Sentry throttle for the fail-open billing paths below. A billing outage
// affects EVERY org at once, so an uncapped report would ship one event per AI
// call across the whole fleet; one per key per hour is enough to alert on.
// Same shape (and same rationale) as llmConfigResolver's local copy —
// deliberately duplicated rather than shared, per the repo's helper guidance.
const BILLING_SENTRY_THROTTLE_MS = 60 * 60 * 1000;
const billingSentryTimestamps = new Map<string, number>();

/**
 * Report at most once per key per hour, and NEVER throw: every call site below
 * sits on a path whose whole contract is that it degrades quietly rather than
 * failing the caller's AI request.
 */
function reportBillingIssueAtMostHourly(key: string, capture: () => void): void {
  try {
    const now = Date.now();
    const last = billingSentryTimestamps.get(key);
    if (last !== undefined && now - last < BILLING_SENTRY_THROTTLE_MS) return;
    billingSentryTimestamps.set(key, now);
    capture();
  } catch {
    // Telemetry must never break the fail-open billing path it observes.
  }
}

// Sandbox COMPUTE pricing (spec §5.6) lives in its own pure module and is
// re-exported here because that is the name the execution-plane wave contract
// uses. Token pricing is not here at all: every model call is priced by
// aiModels/settleInvocation.ts (priceInvocation over the resolver's rate
// snapshot), W03 #7601.
export {
  AI_COMPUTE_PRICE_MULTIPLIER_ENV,
  COMPUTE_PRICING,
  type ComputePrice,
  calculateComputeCents,
  computePriceMultiplier,
} from './aiComputePricing';

/** The record cached at `ai:credits:<partnerId>` and surfaced on /ai/usage. */
export interface CachedPartnerCredits {
  remaining: number;
  includedBalance: number;
  purchasedBalance: number;
  fetchedAt: string;
}

/**
 * How long a fetched partner credit balance stays cached.
 *
 * 15 minutes, up from the 60s this shipped with. The cache used to be written
 * only by {@link checkBillingCreditsDetailed}, which runs only on an actual AI
 * turn: for any org that was not mid-conversation the entry had long expired
 * by the time the usage page or the header cost indicator asked for it, so the
 * credits card rendered on almost no page load and the header flickered
 * between "has credits" and nothing. {@link getUsageSummary} now fills the
 * cache on a miss, and a 15-minute TTL keeps a page refresh from turning into
 * a billing-service round trip every time. A balance this stale is fine for a
 * display surface; the credit GATE always reads live.
 */
const PARTNER_CREDITS_CACHE_TTL_SECONDS = 900;

/** The `/ai-credits` response from breeze-billing. */
interface BillingCreditsPayload {
  allowed: boolean;
  remainingCredits: number;
  plan: string;
  /** Present since breeze-billing's #4388 W04 rollout; optional so this
   *  deploys safely ahead of it, defaulting to 0 in the cached record. */
  includedBalance?: number;
  purchasedBalance?: number;
}

/**
 * Discriminated so each caller can react to a failure the way it needs to:
 * the credit gate reports HTTP and transport failures to Sentry and falls
 * open, while the usage page just shows no credits card.
 */
type PartnerCreditsFetch =
  | { ok: true; payload: BillingCreditsPayload; credits: CachedPartnerCredits }
  | { ok: false; reason: 'unconfigured' }
  | { ok: false; reason: 'http'; status: number }
  | { ok: false; reason: 'transport'; error: unknown };

/**
 * Fetch a partner's platform credit balance from breeze-billing and cache it
 * at `ai:credits:<partnerId>`, the single place that HTTP call is made.
 *
 * Never throws: every failure comes back as an `ok: false` variant, including
 * "no billing service configured", which is the self-hosted default rather
 * than an error. The Redis write is best-effort for the same reason it always
 * was - a Redis outage must degrade the credits CARD, never the credit GATE
 * this call primarily exists to feed.
 */
async function fetchAndCachePartnerCredits(partnerId: string): Promise<PartnerCreditsFetch> {
  const billingUrl = process.env.BILLING_SERVICE_URL;
  const billingKey = process.env.BILLING_SERVICE_API_KEY;
  if (!billingUrl || !billingKey) return { ok: false, reason: 'unconfigured' };

  try {
    const res = await fetch(`${billingUrl}/billing/api/internal/partners/${partnerId}/ai-credits`, {
      headers: { 'Authorization': `Bearer ${billingKey}` },
    });

    if (!res.ok) return { ok: false, reason: 'http', status: res.status };

    const payload = await res.json() as BillingCreditsPayload;

    // Cached per PARTNER, not per org: the balance is partner-wide.
    const credits: CachedPartnerCredits = {
      remaining: payload.remainingCredits,
      includedBalance: payload.includedBalance ?? 0,
      purchasedBalance: payload.purchasedBalance ?? 0,
      fetchedAt: new Date().toISOString(),
    };

    const redis = getRedis();
    if (redis) {
      void redis.set(
        `ai:credits:${partnerId}`,
        JSON.stringify(credits),
        'EX',
        PARTNER_CREDITS_CACHE_TTL_SECONDS,
      ).catch(() => undefined);
    }

    return { ok: true, payload, credits };
  } catch (error) {
    return { ok: false, reason: 'transport', error };
  }
}

/**
 * Legacy string-or-null facade over {@link checkBillingCreditsDetailed}, kept
 * because a dozen call sites branch on `if (creditError) return 402`. New
 * callers that must decide whether RETRYING can help want the detailed form.
 */
export async function checkBillingCredits(
  orgId: string,
  billingSource: AiBillingSource,
): Promise<string | null> {
  return (await checkBillingCreditsDetailed(orgId, billingSource))?.message ?? null;
}

export async function checkBillingCreditsDetailed(
  orgId: string,
  billingSource: AiBillingSource,
): Promise<AiAccessDenial | null> {
  const billingUrl = process.env.BILLING_SERVICE_URL;
  const billingKey = process.env.BILLING_SERVICE_API_KEY;
  // No billing service is the self-hosted default, not a failure — deliberately
  // NOT reported, or every self-hosted instance would ship this hourly forever.
  if (!billingUrl || !billingKey) return null;

  // #2190 — self-context this read (and every other DB op in this module's
  // budget/usage path): the distributor import routes now run WITHOUT an ambient
  // request transaction (SELF_MANAGED_DB_CONTEXT_ROUTES), and a contextless read
  // under forced RLS silently returns 0 rows. withSystemDbAccessContext reuses an
  // already-active ambient context (withDbAccessContext short-circuits), so every
  // existing AI caller behaves identically; only the contextless path escalates.
  // Spend/budget accounting is an internal-metering question keyed by the explicit
  // orgId, not a tenant-visibility one — same rationale as the identity-read
  // escalation in getUserPermissions (services/permissions.ts). The outbound
  // billing fetch below stays OUTSIDE the context.
  const [org] = await withSystemDbAccessContext(() => db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1));

  // `organizations.partner_id` is NOT NULL, so a falsy value here means the row
  // was not found at all — a deleted org still being billed against, or a read
  // that got RLS-filtered to zero rows. Either way the gate silently falls open
  // for that org, which is worth one event an hour.
  if (!org?.partnerId) {
    reportBillingIssueAtMostHourly(`credits-no-partner:${orgId}`, () => {
      captureMessage('AI credit check skipped: no organization row to bill', {
        eventCode: 'ai_billing_org_partner_missing',
        tags: { org_id: orgId, ai_billing_http_status: 'none' },
      });
    });
    return null;
  }

  // #4388 W04: the fetch and the `ai:credits:<partnerId>` cache write both
  // live in fetchAndCachePartnerCredits, so the gate and the usage page share
  // one HTTP path and one cache shape. It never throws; the failure variants
  // are interpreted here, where the orgId needed to tag them is in scope.
  const result = await fetchAndCachePartnerCredits(org.partnerId);

  if (!result.ok) {
    // Fail OPEN on purpose (a billing outage must not take AI down for every
    // tenant), but no longer fail SILENT: the HTTP branch also swallows a 401
    // from a rotated BILLING_SERVICE_API_KEY, which looks exactly like
    // "everyone has credits" from here.
    if (result.reason === 'http') {
      console.error(
        `[AI] Billing credit check returned HTTP ${result.status} for org=${orgId}, allowing the request (fail-open)`,
      );
      reportBillingIssueAtMostHourly(`credits-http:${orgId}`, () => {
        captureMessage('AI credit check failed; gate fell open', {
          eventCode: 'ai_billing_credits_check_failed',
          tags: { org_id: orgId, ai_billing_http_status: String(result.status) },
        });
      });
    } else if (result.reason === 'transport') {
      const err = result.error;
      console.error(
        `[AI] Billing credit check failed for org=${orgId}, allowing the request (fail-open):`,
        err instanceof Error ? err.message : String(err),
      );
      reportBillingIssueAtMostHourly(`credits-throw:${orgId}`, () => {
        captureException(err, undefined, {
          org_id: orgId,
          ai_billing_http_status: 'transport_error',
        });
      });
    }
    // 'unconfigured' cannot be reached here (the env check above returns
    // first) and is deliberately unreported anyway: see that comment.
    return null;
  }

  const data = result.payload;

  if (!data.allowed) {
    if (['free', 'starter'].includes(data.plan)) {
      // A plan gate, not a spend cap: nothing about waiting changes it.
      return denial('plan_gate', 'AI assistant requires the Community plan.');
    }
    if (billingSource === 'platform') {
      return denial(
        'credits_exhausted',
        'You are out of AI credits. Purchase more credits to continue.',
      );
    }
  }

  return null;
}

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
  } catch {
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

/**
 * Draw platform-funded spend down from the org's prepaid AI credit balance.
 *
 * UNKEYED legacy debit, kept for its one remaining caller: compute
 * settlement (settleComputeCents). Token spend uses the keyed
 * debitBillingCredits via settleInvocation (W06 deleted the env-only
 * OpenAI-compatible chat path, its other caller). Only ever call this for
 * `billingSource === 'platform'`: partner BYOK spend is billed by Anthropic to
 * the partner, not against our credits.
 */
export async function deductBillingCredits(orgId: string, costCents: number): Promise<void> {
  const billingUrl = process.env.BILLING_SERVICE_URL;
  const billingKey = process.env.BILLING_SERVICE_API_KEY;
  if (!billingUrl || !billingKey) return;

  // Self-contexted (#2190), and deliberately only around the LOOKUP: the
  // wrapper reuses an ambient request context, so the in-request chat callers
  // are unchanged, while a contextless caller (compute settlement from a
  // headless run) gets a context instead of an RLS-filtered
  // zero-row read that would silently skip every deduction. The fetch below
  // stays outside it — a pooled connection must never be held across a network
  // call (#1105).
  const [org] = await withSystemDbAccessContext(() => db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1));

  // NOT NULL column (see checkBillingCreditsDetailed): falsy means no org row
  // came back, so this spend is about to go unbilled with nothing said.
  if (!org?.partnerId) {
    reportBillingIssueAtMostHourly(`deduct-no-partner:${orgId}`, () => {
      captureMessage('AI credit deduction skipped: no organization row to bill', {
        eventCode: 'ai_billing_org_partner_missing',
        tags: { org_id: orgId, ai_billing_http_status: 'none' },
      });
    });
    return;
  }

  try {
    const res = await fetch(`${billingUrl}/billing/api/internal/partners/${org.partnerId}/ai-credits/deduct`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${billingKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ costCents }),
    });

    // The status was previously discarded entirely: a 4xx/5xx from the billing
    // service dropped this platform-funded spend on the floor with no log line
    // and no event, so the credit balance both budget gates read silently
    // drifted above what was actually consumed. Still non-throwing — usage is
    // already recorded and the caller's AI response must not fail over billing.
    if (!res.ok) {
      console.error(
        `[AI] Billing credit deduction returned HTTP ${res.status} for org=${orgId}, cost=${costCents} cents — spend not deducted`,
      );
      reportBillingIssueAtMostHourly(`deduct-http:${orgId}`, () => {
        captureMessage('AI credit deduction rejected; platform spend went unbilled', {
          eventCode: 'ai_billing_credits_deduct_failed',
          tags: { org_id: orgId, ai_billing_http_status: String(res.status) },
        });
      });
    }
  } catch (err) {
    console.error('[AI] Failed to deduct billing credits:', err instanceof Error ? err.message : String(err));
    reportBillingIssueAtMostHourly(`deduct-throw:${orgId}`, () => {
      captureException(err, undefined, {
        org_id: orgId,
        ai_billing_http_status: 'transport_error',
      });
    });
  }
}

/**
 * Execution plane W04 (spec §5.6 "Reservation") — the credits gate for the
 * SANDBOX COMPUTE leg of an analysis run.
 *
 * Compute is OURS regardless of who pays for tokens: a BYOK partner pays
 * Anthropic for the model, but the microVM is billed to us, so this is
 * checked (and later deducted) for `platform` runs exactly like token spend,
 * and skipped for `partner_key` — which does NOT mean partner_key compute is
 * free: it is charged and settled on the run row and `ai_cost_usage` all the
 * same ({@link settleComputeCents}), just not against prepaid AI credits.
 *
 * A SIBLING of `checkBillingCredits` rather than a parameter on it: a dozen
 * call sites branch on that function's `string | null` shape and none of them
 * has a compute leg to declare.
 *
 * `reserveCents` is the reservation about to be taken, not spend already
 * incurred — this runs BEFORE the run row exists, which is the whole point
 * (spec §5.6: "this is the fix for the 'credits are enforced after the fact'
 * gap for this lane").
 */
export async function checkComputeCredits(
  orgId: string,
  billingSource: AiBillingSource,
  reserveCents: number,
): Promise<AiAccessDenial | null> {
  if (billingSource !== 'platform') return null;
  if (reserveCents <= 0) return null;
  return checkBillingCreditsDetailed(orgId, billingSource);
}

/**
 * Execution plane W04 (spec §5.6) — stamp an analysis run's compute
 * RESERVATION on its own row.
 *
 * The reservation is what makes concurrent admissions safe: admission sums
 * settled `compute_cents` PLUS outstanding `compute_reserved_cents` for the
 * day, so N runs that each fit under the ceiling cannot collectively blow
 * through it. It is deliberately stored on the run rather than in Redis —
 * a reservation that evaporates with a cache is a reservation that does not
 * bound anything, and the row is already the durable record the settlement
 * writes back to.
 *
 * Non-throwing is NOT an option here: a reservation that silently failed to
 * write would leave the run admitted with no fence at all, so the caller
 * takes it inside the same transaction as every other admission counter.
 */
export async function reserveComputeCents(
  orgId: string,
  runId: string,
  reserveCents: number,
  _billingSource: AiBillingSource,
): Promise<void> {
  if (reserveCents <= 0) return;
  await withSystemDbAccessContext(() => db
    .update(aiAgentRuns)
    .set({ computeReservedCents: reserveCents })
    .where(and(eq(aiAgentRuns.id, runId), eq(aiAgentRuns.orgId, orgId))));
}

/**
 * Execution plane W04 (spec §5.6, §9) — replace a run's reservation with what
 * the sandbox actually cost.
 *
 * Called from the run loop's `finally` for EVERY billing source, and from the
 * admission enqueue-failure path with `0` (that zero IS the release: there is
 * exactly one way a reservation ever ends). `compute_reserved_cents` is
 * cleared in the same statement that writes `compute_cents`, so the daily sum
 * can never double-count a settled run.
 *
 * Credits are deducted only for `platform`; a BYOK partner is still CHARGED
 * (the row and the `ai_cost_usage` rollup carry the cents) — they just do not
 * come out of prepaid AI credits, exactly like token spend.
 */
export async function settleComputeCents(
  orgId: string,
  runId: string,
  actualCents: number,
  billingSource: AiBillingSource,
): Promise<void> {
  const cents = Number.isFinite(actualCents) && actualCents > 0 ? Math.ceil(actualCents) : 0;

  await withSystemDbAccessContext(() => db
    .update(aiAgentRuns)
    .set({ computeCents: cents, computeReservedCents: null })
    .where(and(eq(aiAgentRuns.id, runId), eq(aiAgentRuns.orgId, orgId))));

  if (cents <= 0) return;

  const now = new Date();
  const dailyKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
  const monthlyKey = dailyKey.slice(0, 7);
  for (const [period, periodKey] of [['daily', dailyKey], ['monthly', monthlyKey]] as const) {
    try {
      await withSystemDbAccessContext(() => db
        .insert(aiCostUsage)
        .values({ orgId, period, periodKey, computeCents: cents, billingSource })
        .onConflictDoUpdate({
          target: [aiCostUsage.orgId, aiCostUsage.period, aiCostUsage.periodKey],
          set: {
            computeCents: sql`${aiCostUsage.computeCents} + ${cents}`,
            updatedAt: new Date(),
          },
        }));
    } catch (err) {
      // Same posture as the token rollup above: a failed aggregate must not
      // fail the run, and the authoritative number is on the run row
      // (`ai_agent_runs.compute_cents`, written above and outside this catch)
      // — admission's daily ceiling reads THAT, not this column. Paged anyway:
      // nothing reconciles a dropped rollup, so the drift is permanent, and
      // silent permanent drift in a spend column is how an invoice built on it
      // later comes out wrong with no record of why.
      console.error(`[AI] Failed to roll up ${period} compute for org=${orgId}, run=${runId}:`, err);
      captureException(err instanceof Error ? err : new Error(String(err)));
    }
  }

  if (billingSource === 'platform') {
    await deductBillingCredits(orgId, cents);
  }
}

export interface SdkInputTokenUsage {
  input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/**
 * Total input tokens for a turn — uncached + cache-read + cache-creation.
 *
 * The SDK reports these three separately because they are PRICED differently
 * (separate registry rates), not because only the first one is "input". They
 * are three disjoint slices of one prompt: every token in the request lands in
 * exactly one of them, so summing cannot double-count.
 *
 * The `*_input_tokens` columns store this sum. Recording only `input_tokens`
 * made them worse than useless on any multi-turn session, where prompt caching
 * routes almost the whole prompt through cache_read: release QA saw an 8-turn
 * session report 17 input tokens against 1029 output tokens and $0.57 of spend.
 * Cost was never affected — it is computed from the three split values, and
 * still is (this sum is deliberately NOT fed back into the pricing call).
 *
 * Total by construction: a nullish usage object or component yields 0 rather
 * than throwing. This sits on the streaming `done` path, ahead of both the
 * per-user usage hook and the `done` publish that returns the session to
 * 'idle' — a throw there would strand the turn and hang the client, so it must
 * not have a failure mode.
 */
export function sumInputTokens(usage: SdkInputTokenUsage | null | undefined): number {
  return (
    (usage?.input_tokens ?? 0) +
    (usage?.cache_read_input_tokens ?? 0) +
    (usage?.cache_creation_input_tokens ?? 0)
  );
}

/**
 * Check if the org is within budget limits before sending a message.
 * Returns null if allowed, or an error message if blocked.
 */
export async function checkBudget(
  orgId: string,
  billingSource: AiBillingSource,
): Promise<string | null> {
  return (await checkBudgetDetailed(orgId, billingSource))?.message ?? null;
}

/**
 * As {@link checkBudget}, but says WHY — and in particular whether retrying can
 * ever help. Non-interactive callers (ingest job phases, background sweeps)
 * must use this form: a permanent denial has to degrade the feature, while a
 * transient one should back off and come back.
 */
export async function checkBudgetDetailed(
  orgId: string,
  billingSource: AiBillingSource,
): Promise<AiAccessDenial | null> {
  const creditError = await checkBillingCreditsDetailed(orgId, billingSource);
  if (creditError) return creditError;

  // #2190 — getEffectiveAiBudget reads organizations/partners/aiBudgets; run
  // contextless (the exempted distributor import routes) the org read is
  // RLS-filtered to 0 rows and throws a 404, silently disabling enrichment.
  // Self-context it; the wrapper reuses any active ambient context (see the
  // rationale on checkBillingCredits above).
  const budget = await withSystemDbAccessContext(() => getEffectiveAiBudget(orgId));
  // PERMANENT: the tenant (or their partner) switched AI off. No retry, no
  // clock rollover and no top-up changes it — only someone flipping it back.
  if (!budget.enabled) {
    return denial('ai_disabled', 'AI features are disabled for this organization');
  }

  const now = new Date();
  const dailyKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
  const monthlyKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

  // Check daily budget
  if (budget.dailyBudgetCents) {
    // #2190 — self-contexted: contextless this read returned 0 rows, silently
    // skipping budget enforcement.
    const [dailyUsage] = await withSystemDbAccessContext(() => db
      .select({ totalCostCents: aiCostUsage.totalCostCents })
      .from(aiCostUsage)
      .where(
        and(
          eq(aiCostUsage.orgId, orgId),
          eq(aiCostUsage.period, 'daily'),
          eq(aiCostUsage.periodKey, dailyKey)
        )
      )
      .limit(1));

    if (dailyUsage && dailyUsage.totalCostCents >= budget.dailyBudgetCents) {
      // Transient: the daily period key rolls at UTC midnight.
      return denial(
        'daily_budget',
        `Daily AI budget exceeded ($${(budget.dailyBudgetCents / 100).toFixed(2)})`,
      );
    }
  }

  // Check monthly budget
  if (budget.monthlyBudgetCents) {
    // #2190 — self-contexted (same as the daily read above).
    const [monthlyUsage] = await withSystemDbAccessContext(() => db
      .select({ totalCostCents: aiCostUsage.totalCostCents })
      .from(aiCostUsage)
      .where(
        and(
          eq(aiCostUsage.orgId, orgId),
          eq(aiCostUsage.period, 'monthly'),
          eq(aiCostUsage.periodKey, monthlyKey)
        )
      )
      .limit(1));

    if (monthlyUsage && monthlyUsage.totalCostCents >= budget.monthlyBudgetCents) {
      // Transient: the monthly period key rolls at the start of the next month.
      return denial(
        'monthly_budget',
        `Monthly AI budget exceeded ($${(budget.monthlyBudgetCents / 100).toFixed(2)})`,
      );
    }
  }

  return null;
}

/**
 * Check rate limits for AI messages.
 * Returns null if allowed, or an error message if rate limited.
 */
export async function checkAiRateLimit(
  userId: string,
  orgId: string
): Promise<string | null> {
  const redis = getRedis();

  // Load effective rate limits (partner overrides org).
  // #2190 — despite this function being otherwise Redis-only, this call reads
  // organizations/partners/aiBudgets; contextless (exempted import routes) the
  // org read is RLS-filtered to 0 rows and throws a 404. Self-context it; the
  // wrapper reuses any active ambient context (see checkBillingCredits).
  const budget = await withSystemDbAccessContext(() => getEffectiveAiBudget(orgId));
  const msgsPerMin = budget?.messagesPerMinutePerUser ?? 20;
  const msgsPerHour = budget?.messagesPerHourPerOrg ?? 200;

  // Per-user rate limit
  const userResult = await rateLimiter(redis, `ai:msg:user:${userId}`, msgsPerMin, 60);
  if (!userResult.allowed) {
    return `Rate limit exceeded. Try again at ${userResult.resetAt.toISOString()}`;
  }

  // Per-org rate limit
  const orgResult = await rateLimiter(redis, `ai:msg:org:${orgId}`, msgsPerHour, 3600);
  if (!orgResult.allowed) {
    return `Organization rate limit exceeded. Try again at ${orgResult.resetAt.toISOString()}`;
  }

  return null;
}

/**
 * Per-user-only rate limit, for AI endpoints reached without an org context (so
 * no org budget applies) — e.g. partner-level catalog "Polish with AI". Uses the
 * same per-user key/window as checkAiRateLimit's user check (a default 20/min, no
 * per-org effective override available since there's no org), so it bounds spend
 * from a scope-only caller. Returns a message when blocked, null when allowed.
 */
export async function checkUserAiRateLimit(userId: string): Promise<string | null> {
  const redis = getRedis();
  const userResult = await rateLimiter(redis, `ai:msg:user:${userId}`, 20, 60);
  if (!userResult.allowed) {
    return `Rate limit exceeded. Try again at ${userResult.resetAt.toISOString()}`;
  }
  return null;
}

/**
 * Org-scoped rate limit for non-interactive AI work driven by a SYSTEM
 * principal (no acting user) — e.g. an extension's bulk enrichment batch.
 *
 * Deliberately skips `checkAiRateLimit`'s per-USER bucket. That bucket is keyed
 * `ai:msg:user:<id>` with no org component, so a synthetic actor id ("this
 * surface") would put every tenant's automation in ONE deployment-wide bucket —
 * one partner's batch would rate-limit everybody else's. Keying the synthetic
 * actor per org fixes the coupling but still caps automation at the
 * interactive-chat 20/min, which a legitimate 100-file batch trips. The per-org
 * HOURLY ceiling is the meaningful bound here, and `checkBudget` bounds spend.
 */
export async function checkSystemAiRateLimit(orgId: string): Promise<string | null> {
  const redis = getRedis();
  // Self-contexted for the same reason as checkAiRateLimit (#2190).
  const budget = await withSystemDbAccessContext(() => getEffectiveAiBudget(orgId));
  const msgsPerHour = budget?.messagesPerHourPerOrg ?? 200;

  const orgResult = await rateLimiter(redis, `ai:msg:org:${orgId}`, msgsPerHour, 3600);
  if (!orgResult.allowed) {
    return `Organization rate limit exceeded. Try again at ${orgResult.resetAt.toISOString()}`;
  }
  return null;
}

/**
 * Get the remaining monthly budget for an org in USD.
 * Returns null if no budget is configured (unlimited).
 */
export async function getRemainingBudgetUsd(orgId: string): Promise<number | null> {
  const [budget] = await db
    .select()
    .from(aiBudgets)
    .where(eq(aiBudgets.orgId, orgId))
    .limit(1);

  if (!budget || !budget.monthlyBudgetCents) return null;

  const now = new Date();
  const monthlyKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

  const [monthlyUsage] = await db
    .select({ totalCostCents: aiCostUsage.totalCostCents })
    .from(aiCostUsage)
    .where(
      and(
        eq(aiCostUsage.orgId, orgId),
        eq(aiCostUsage.period, 'monthly'),
        eq(aiCostUsage.periodKey, monthlyKey)
      )
    )
    .limit(1);

  const usedCents = monthlyUsage?.totalCostCents ?? 0;
  const remainingCents = Math.max(0, budget.monthlyBudgetCents - usedCents);
  return remainingCents / 100; // Convert cents to USD
}

/**
 * Check for cost anomalies after spend is recorded: evaluates the budget alert
 * rungs and logs a warning for a session consuming too much budget. Called
 * fire-and-forget by aiModels/settleInvocation.ts after every settled spend.
 */
export async function checkCostAnomalies(
  sessionId: string | null,
  orgId: string,
  costCents: number
): Promise<void> {
  // #2190 — self-contexted: reached fire-and-forget after settlement, often
  // with no context held; without a context these reads RLS-filter to
  // 0 rows and the anomaly warnings silently never fire. The whole body is
  // DB reads + console.warn, so one short context covers it; the wrapper
  // reuses any active ambient context (see checkBillingCredits).
  return withSystemDbAccessContext(async () => {
    // #4388 — the 80 %-of-daily console.warn this replaced never reached a
    // user. Durable rung evaluation for both ladders lives in aiBudgetAlerts.
    // Called above the early return below so monthly-only and partner-locked
    // budgets (which have no dailyBudgetCents) are still evaluated.
    await evaluateAiBudgetThresholds(orgId);

    const [budget] = await db
      .select()
      .from(aiBudgets)
      .where(eq(aiBudgets.orgId, orgId))
      .limit(1);

    if (!budget || !budget.dailyBudgetCents) return;

    // Check if single session exceeds 10% of daily budget. Sessionless flows
    // (sessionId === null, e.g. catalog enrichment) have no per-session row, so
    // skip straight to the org-level daily check.
    const [session] = sessionId === null
      ? [undefined]
      : await db
          .select({ totalCostCents: aiSessions.totalCostCents })
          .from(aiSessions)
          .where(eq(aiSessions.id, sessionId))
          .limit(1);

    if (session && session.totalCostCents > budget.dailyBudgetCents * 0.1) {
      console.warn(
        `[AI] Cost anomaly: session ${sessionId} has used ${session.totalCostCents} cents ` +
        `(>${Math.round(budget.dailyBudgetCents * 0.1)} cents = 10% of daily budget)`
      );
    }
  });
}

/**
 * Update the AI budget for an org.
 */
export async function updateBudget(orgId: string, settings: {
  enabled?: boolean;
  monthlyBudgetCents?: number | null;
  dailyBudgetCents?: number | null;
  maxTurnsPerSession?: number;
  messagesPerMinutePerUser?: number;
  messagesPerHourPerOrg?: number;
  approvalMode?: 'per_step' | 'action_plan' | 'auto_approve' | 'hybrid_plan';
  alertThresholdPercents?: number[] | null;
  toolRateLimitMultiplier?: number;
}): Promise<void> {
  // Serialize local budget changes with reserve/settle, which use the same
  // stable org row as their transaction lock. Without this, lowering or
  // disabling a budget can race a provider admission based on stale settings.
  await db.execute(sql`
    SELECT id FROM organizations WHERE id = ${orgId}::uuid FOR UPDATE
  `);
  const [existing] = await db
    .select()
    .from(aiBudgets)
    .where(eq(aiBudgets.orgId, orgId))
    .limit(1);

  if (existing) {
    await db.update(aiBudgets).set({
      ...settings,
      updatedAt: new Date()
    }).where(eq(aiBudgets.orgId, orgId));
  } else {
    await db.insert(aiBudgets).values({
      orgId,
      enabled: settings.enabled ?? true,
      monthlyBudgetCents: settings.monthlyBudgetCents ?? null,
      dailyBudgetCents: settings.dailyBudgetCents ?? null,
      maxTurnsPerSession: settings.maxTurnsPerSession ?? 50,
      messagesPerMinutePerUser: settings.messagesPerMinutePerUser ?? 20,
      messagesPerHourPerOrg: settings.messagesPerHourPerOrg ?? 200,
      // #5592 — this branch enumerates columns, so every field of the
      // `settings` parameter must appear here. Omitting one silently discards
      // the user's choice on the FIRST save (the row takes the column default)
      // and only sticks on the second save, which takes the update branch.
      approvalMode: settings.approvalMode ?? 'per_step',
      alertThresholdPercents: settings.alertThresholdPercents ?? null,
      toolRateLimitMultiplier: settings.toolRateLimitMultiplier ?? 1,
    });
  }
}

/**
 * Get session history for admin dashboard.
 */
export async function getSessionHistory(
  orgId: string,
  options: { limit?: number; offset?: number; flagged?: boolean },
  /** Topology M4-D2: the CALLER's pinned-site visibility, applied before LIMIT/OFFSET. Absent = no pinned session is shown. */
  topologyVisibility: TopologySessionVisibility = { kind: 'none' },
): Promise<Array<{
  id: string;
  userId: string | null;
  title: string | null;
  model: string;
  turnCount: number;
  totalCostCents: number;
  status: string;
  flaggedAt: Date | null;
  flaggedBy: string | null;
  flagReason: string | null;
  createdAt: Date;
}>> {
  const limit = Math.min(options.limit ?? 50, 100);
  const offset = options.offset ?? 0;

  const conditions = [eq(aiSessions.orgId, orgId)];
  if (options.flagged) {
    conditions.push(isNotNull(aiSessions.flaggedAt));
  }
  const topologyCondition = topologySessionCondition(topologyVisibility);
  if (topologyCondition) conditions.push(topologyCondition);

  return db
    .select({
      id: aiSessions.id,
      userId: aiSessions.userId,
      title: aiSessions.title,
      model: aiSessions.model,
      turnCount: aiSessions.turnCount,
      totalCostCents: aiSessions.totalCostCents,
      status: aiSessions.status,
      flaggedAt: aiSessions.flaggedAt,
      flaggedBy: aiSessions.flaggedBy,
      flagReason: aiSessions.flagReason,
      createdAt: aiSessions.createdAt
    })
    .from(aiSessions)
    .where(and(...conditions))
    .orderBy(desc(aiSessions.createdAt), desc(aiSessions.id))
    .limit(limit)
    .offset(offset);
}

/**
 * The catalog entry the org's MOST RECENT session used, or null when that
 * session ran direct (or the org has no sessions at all) (#3922 W4). Reads the
 * raw `catalog_entry_id` stamped on session create
 * ({@link streamingSessionManager.ts}) — independent of the entry's current
 * listing status, since a delisted-but-previously-used endpoint should still
 * be nameable on the usage page.
 *
 * Deliberately NOT filtered to sessions that have a catalog entry: the usage
 * page renders this in the present tense ("Billed to your key via <name>"), so
 * narrowing to catalog-routed sessions would pin the note to the last endpoint
 * ever used and keep asserting it after the partner switched back to Anthropic
 * (direct) or to a different endpoint — a misstatement that never self-corrects
 * on the exact surface this wave designates for routing provenance.
 */
async function getRecentCatalogEntryIdForOrg(orgId: string): Promise<string | null> {
  const [row] = await db
    .select({ catalogEntryId: aiSessions.catalogEntryId })
    .from(aiSessions)
    .where(eq(aiSessions.orgId, orgId))
    .orderBy(desc(aiSessions.lastActivityAt))
    .limit(1);
  return row?.catalogEntryId ?? null;
}

/**
 * Read the partner's platform credit balance for the usage page: cache first,
 * billing service on a miss.
 *
 * Read-through because the cache used to be written only by an actual AI turn
 * (see {@link PARTNER_CREDITS_CACHE_TTL_SECONDS}), which meant the credits
 * card essentially never had anything to render. Every failure mode - no
 * partner row, Redis down, a corrupt cache entry, billing unreachable -
 * degrades to `null` rather than a 500 on /ai/usage.
 */
async function readPartnerCreditsForUsage(orgId: string): Promise<CachedPartnerCredits | null> {
  try {
    const [org] = await db
      .select({ partnerId: organizations.partnerId })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    if (!org?.partnerId) return null;

    const redis = getRedis();
    if (redis) {
      const raw = await redis.get(`ai:credits:${org.partnerId}`);
      // A cache hit must NOT hit billing: /ai/usage is polled by the header
      // cost indicator on every page.
      if (raw) return JSON.parse(raw) as CachedPartnerCredits;
    }

    const fetched = await fetchAndCachePartnerCredits(org.partnerId);
    return fetched.ok ? fetched.credits : null;
  } catch {
    return null;
  }
}

/**
 * Task 15 (#7601): "what will a chat here bill to?" is the funding of the
 * offering a chat in this org resolves to now (per offering, never inferred
 * per org). When chat cannot resolve (no eligible model, registry not cut
 * over yet, no partner), the label of the spend already recorded this month
 * (the monthly rollup row the ledger settlement stamps), then `platform`.
 * A display read: it never throws.
 */
async function resolveUsageBilledTo(
  orgId: string,
  monthlyBillingSource: AiBillingSource | null | undefined,
): Promise<AiBillingSource> {
  const rollupLabel: AiBillingSource = monthlyBillingSource === 'partner_key' ? 'partner_key' : 'platform';
  try {
    // Lazy: the resolver graph (registry cutover, legacy projection) must not
    // load with every aiCostTracker importer.
    const { readOrgPartnerId } = await import('./aiModels/candidateLoader');
    const partnerId = await readOrgPartnerId(orgId);
    if (!partnerId) return rollupLabel;
    const { resolveModel } = await import('./aiModels/resolveModel');
    const chat = await resolveModel({ partnerId, orgId, surface: 'chat' });
    return chat.ok ? chat.funding : rollupLabel;
  } catch (error) {
    // /ai/usage is polled by the header indicator: one report per org per hour.
    captureAtMostHourly(`usage-billed-to:${orgId}`, () => {
      captureException(error instanceof Error ? error : new Error(String(error)), undefined, {
        service: 'aiCostTracker.getUsageSummary', orgId,
      });
    });
    return rollupLabel;
  }
}

/**
 * Get usage summary for an org.
 *
 * `includeCredits` gates the partner-wide credit pool, which an org-scoped
 * caller must never see: it is the MSP's balance, shared across every one of
 * its customers, so surfacing it to one customer's users leaks a partner-level
 * figure across the tenancy boundary. Off by default so a new call site has to
 * opt in deliberately (see the /ai/usage route).
 */
export async function getUsageSummary(orgId: string, options: { includeCredits?: boolean } = {}): Promise<{
  daily: { inputTokens: number; outputTokens: number; totalCostCents: number; messageCount: number };
  monthly: { inputTokens: number; outputTokens: number; totalCostCents: number; messageCount: number };
  budget: {
    enabled: boolean;
    monthlyBudgetCents: number | null;
    dailyBudgetCents: number | null;
    monthlyUsedCents: number;
    dailyUsedCents: number;
    approvalMode: string;
    /** #4388: pre-cap alert rungs (1-99), partner-override-aware. */
    alertThresholdPercents: number[];
  };
  billedTo: AiBillingSource;
  /** Name of the catalog endpoint the org's most recent session used, or null
   *  for direct-Anthropic / platform-key traffic (#3922 W4). */
  catalogEndpointName: string | null;
  /** #4388 W04: the partner's platform-credit balance. `null` unless the
   *  caller passed `includeCredits` (an org-scoped caller must not see the
   *  partner-wide pool), when billed to the partner's own key (BYOK: no
   *  platform credits apply), when the org has no partner id, or when neither
   *  the cache nor the billing service can produce one. Never throws. */
  credits: CachedPartnerCredits | null;
  /** #4388: threshold rungs already fired for the org's CURRENT daily and
   *  monthly periods (nothing from prior, rolled-over periods). */
  alerts: {
    fired: Array<{
      period: 'daily' | 'monthly';
      periodKey: string;
      thresholdPct: number;
      createdAt: string;
      deliveredAt: string | null;
    }>;
  };
}> {
  const now = new Date();
  const dailyKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
  const monthlyKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

  const [dailyUsage] = await db
    .select()
    .from(aiCostUsage)
    .where(and(eq(aiCostUsage.orgId, orgId), eq(aiCostUsage.period, 'daily'), eq(aiCostUsage.periodKey, dailyKey)))
    .limit(1);

  const [monthlyUsage] = await db
    .select()
    .from(aiCostUsage)
    .where(and(eq(aiCostUsage.orgId, orgId), eq(aiCostUsage.period, 'monthly'), eq(aiCostUsage.periodKey, monthlyKey)))
    .limit(1);

  // #4388: the EFFECTIVE budget (org row merged with any partner-wide
  // override), not the raw ai_budgets row: a partner-set cap must show up
  // here exactly like it already does in checkBudgetDetailed. Self-contexted
  // for the same #2190 reason as that function; see the comment there.
  const budget = await withSystemDbAccessContext(() => getEffectiveAiBudget(orgId));

  const fired = await db.execute<{
    period: 'daily' | 'monthly';
    period_key: string;
    threshold_pct: number;
    created_at: string;
    delivered_at: string | null;
  }>(sql`
    SELECT period, period_key, threshold_pct, created_at, delivered_at
    FROM ai_budget_alert_events
    WHERE org_id = ${orgId}::uuid
      AND ((period = 'daily' AND period_key = ${dailyKey}) OR (period = 'monthly' AND period_key = ${monthlyKey}))
    ORDER BY created_at, id
  `);

  const billedTo = await resolveUsageBilledTo(orgId, monthlyUsage?.billingSource);

  // Only worth a lookup when traffic is actually billed to the partner's own
  // key — platform-key orgs never stamp a catalog_entry_id on their sessions.
  let catalogEndpointName: string | null = null;
  if (billedTo === 'partner_key') {
    const entryId = await getRecentCatalogEntryIdForOrg(orgId);
    if (entryId) catalogEndpointName = await getCatalogEntryName(entryId);
  }

  // #4388 W04: the partner credit balance. Withheld from org-scoped callers
  // (see the `includeCredits` note on this function), and only meaningful for
  // platform-billed orgs at all - a partner_key/BYOK org spends against its
  // own Anthropic account, not platform credits.
  const credits = options.includeCredits && billedTo === 'platform'
    ? await readPartnerCreditsForUsage(orgId)
    : null;

  return {
    daily: {
      inputTokens: dailyUsage?.inputTokens ?? 0,
      outputTokens: dailyUsage?.outputTokens ?? 0,
      totalCostCents: dailyUsage?.totalCostCents ?? 0,
      messageCount: dailyUsage?.messageCount ?? 0
    },
    monthly: {
      inputTokens: monthlyUsage?.inputTokens ?? 0,
      outputTokens: monthlyUsage?.outputTokens ?? 0,
      totalCostCents: monthlyUsage?.totalCostCents ?? 0,
      messageCount: monthlyUsage?.messageCount ?? 0
    },
    budget: {
      enabled: budget.enabled,
      monthlyBudgetCents: budget.monthlyBudgetCents,
      dailyBudgetCents: budget.dailyBudgetCents,
      monthlyUsedCents: monthlyUsage?.totalCostCents ?? 0,
      dailyUsedCents: dailyUsage?.totalCostCents ?? 0,
      approvalMode: budget.approvalMode ?? 'per_step',
      alertThresholdPercents: budget.alertThresholdPercents,
    },
    billedTo,
    catalogEndpointName,
    credits,
    alerts: {
      fired: fired.map((r) => ({
        period: r.period,
        periodKey: r.period_key,
        thresholdPct: Number(r.threshold_pct),
        createdAt: new Date(r.created_at).toISOString(),
        deliveredAt: r.delivered_at ? new Date(r.delivered_at).toISOString() : null,
      })),
    },
  };
}
