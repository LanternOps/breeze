/**
 * AI Cost Tracker
 *
 * Tracks token usage and costs per message, enforces budget limits,
 * and provides usage summaries.
 */

import { db, withSystemDbAccessContext } from '../db';
import { aiSessions, aiCostUsage, aiBudgets, organizations } from '../db/schema';
import { eq, and, sql, desc, isNotNull } from 'drizzle-orm';
import { getRedis } from './redis';
import { rateLimiter } from './rate-limit';
import { getEffectiveAiBudget } from './effectiveSettings';
import { getLlmBillingSourceForOrg } from './llm/llmConfigResolver';
import { captureException, captureMessage } from './sentry';
import { evaluateAiBudgetThresholds } from './aiBudgetAlerts';
import { getCatalogEntryName } from './llmProviderCatalog';

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

// Cost per million tokens, expressed in cents (USD * 100).
// Source: official Anthropic pricing — https://platform.claude.com/docs/en/about-claude/models/overview
// (input / output $/MTok): opus-4-8 $5/$25, sonnet-4-6 $3/$15, haiku-4-5 $1/$5, fable-5 $10/$50.
// Verified 2026-06-13. Do NOT edit these without re-confirming against the official pricing page.
// Both the dateless alias and the pinned dated snapshot are keyed where one exists, since callers
// may pass either form (the SDK / DB sessions use the alias; legacy rows may carry the dated id).
const MODEL_PRICING: Record<string, { inputPerMillion: number; outputPerMillion: number }> = {
  // Current models
  'claude-opus-4-8': { inputPerMillion: 500, outputPerMillion: 2500 },
  'claude-sonnet-4-6': { inputPerMillion: 300, outputPerMillion: 1500 },
  'claude-haiku-4-5': { inputPerMillion: 100, outputPerMillion: 500 },
  'claude-haiku-4-5-20251001': { inputPerMillion: 100, outputPerMillion: 500 },
  'claude-fable-5': { inputPerMillion: 1000, outputPerMillion: 5000 },
  // Legacy / previously-default models still seen on older sessions
  'claude-sonnet-4-5': { inputPerMillion: 300, outputPerMillion: 1500 },
  'claude-sonnet-4-5-20250929': { inputPerMillion: 300, outputPerMillion: 1500 }
};

export function isPricedModel(model: string): boolean {
  return model in MODEL_PRICING;
}

// Models a partner may pin as their BYOK default. MODEL_PRICING keeps legacy
// snapshot ids for cost attribution on old sessions; those must not be offered
// (or accepted) as new defaults — a retired snapshot pinned partner-wide fails
// every AI session against the partner's own key.
export const OFFERABLE_AI_MODELS: readonly string[] = Object.freeze([
  'claude-opus-4-8',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
  'claude-fable-5',
]);

// Conservative last-resort pricing for an unrecognized model id. Mirrors the most
// expensive current Opus-tier rate so we never silently undercount. Hitting this is logged.
const DEFAULT_PRICING = { inputPerMillion: 500, outputPerMillion: 2500 };

// Prompt-caching price multipliers, applied to the model's base input rate.
// Standard Anthropic convention: a cache READ is billed at 0.1x the input rate
// (https://platform.claude.com/docs/en/build-with-claude/prompt-caching) and a
// cache WRITE / creation (5-minute TTL) is billed at 1.25x the input rate. These
// are reused across every model since Anthropic prices cache tokens as a fixed
// fraction of the per-model input rate rather than as separate flat amounts.
const CACHE_READ_INPUT_MULTIPLIER = 0.1;
const CACHE_WRITE_INPUT_MULTIPLIER = 1.25;

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

  try {
    const res = await fetch(`${billingUrl}/api/internal/partners/${org.partnerId}/ai-credits`, {
      headers: { 'Authorization': `Bearer ${billingKey}` },
    });

    if (!res.ok) {
      // Fail OPEN on purpose (a billing outage must not take AI down for every
      // tenant) — but no longer fail SILENT: this branch also swallows a 401
      // from a rotated BILLING_SERVICE_API_KEY, which looks exactly like
      // "everyone has credits" from here.
      console.error(
        `[AI] Billing credit check returned HTTP ${res.status} for org=${orgId} — allowing the request (fail-open)`,
      );
      reportBillingIssueAtMostHourly(`credits-http:${orgId}`, () => {
        captureMessage('AI credit check failed; gate fell open', {
          eventCode: 'ai_billing_credits_check_failed',
          tags: { org_id: orgId, ai_billing_http_status: String(res.status) },
        });
      });
      return null;
    }

    const data = await res.json() as {
      allowed: boolean;
      remainingCredits: number;
      plan: string;
      /** breeze-billing added these alongside `remainingCredits` (in flight,
       *  #4388 W04) — optional here so this deploys safely ahead of that
       *  billing-service rollout; both default to 0 in the cached record
       *  until the field actually starts arriving. */
      includedBalance?: number;
      purchasedBalance?: number;
    };

    // #4388 W04: cache the latest balance per PARTNER (not per org — the
    // balance is partner-wide) so getUsageSummary can surface it on
    // /ai/usage without its own billing-service round trip. Best-effort: a
    // Redis outage must not affect the credit gate this function exists for.
    const redis = getRedis();
    if (redis) {
      void redis.set(
        `ai:credits:${org.partnerId}`,
        JSON.stringify({
          remaining: data.remainingCredits,
          includedBalance: data.includedBalance ?? 0,
          purchasedBalance: data.purchasedBalance ?? 0,
          fetchedAt: new Date().toISOString(),
        }),
        'EX',
        60,
      ).catch(() => undefined);
    }

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
  } catch (err) {
    console.error(
      `[AI] Billing credit check failed for org=${orgId} — allowing the request (fail-open):`,
      err instanceof Error ? err.message : String(err),
    );
    reportBillingIssueAtMostHourly(`credits-throw:${orgId}`, () => {
      captureException(err, undefined, {
        org_id: orgId,
        ai_billing_http_status: 'transport_error',
      });
    });
    return null;
  }
}

/**
 * Draw platform-funded spend down from the org's prepaid AI credit balance.
 *
 * Exported for callers that record usage through `recordUsage` (which does NOT
 * deduct — see the note on `recordSessionlessSdkUsage`) and therefore have to
 * make the deduction themselves. Only ever call this for
 * `billingSource === 'platform'`: partner BYOK spend is billed by Anthropic to
 * the partner, not against our credits.
 */
export async function deductBillingCredits(orgId: string, costCents: number): Promise<void> {
  const billingUrl = process.env.BILLING_SERVICE_URL;
  const billingKey = process.env.BILLING_SERVICE_API_KEY;
  if (!billingUrl || !billingKey) return;

  // Self-contexted (#2190), and deliberately only around the LOOKUP: the
  // wrapper reuses an ambient request context, so the in-request chat callers
  // are unchanged, while the contextless headless-run caller
  // (`recordSessionlessSdkUsage`) gets a context instead of an RLS-filtered
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
    const res = await fetch(`${billingUrl}/api/internal/partners/${org.partnerId}/ai-credits/deduct`, {
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
 * Look up the model id recorded on a session, used to price tokens when the SDK
 * does not report a cost. Returns null if the session can't be found.
 */
async function getSessionModel(sessionId: string): Promise<string | null> {
  try {
    const [row] = await db
      .select({ model: aiSessions.model })
      .from(aiSessions)
      .where(eq(aiSessions.id, sessionId))
      .limit(1);
    return row?.model ?? null;
  } catch (err) {
    console.error(`[AI] Failed to look up model for session=${sessionId}:`, err);
    return null;
  }
}

/** The three components the Anthropic/SDK usage object splits input across. */
export interface SdkInputTokenUsage {
  input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/**
 * Total input tokens for a turn — uncached + cache-read + cache-creation.
 *
 * The SDK reports these three separately because they are PRICED differently
 * (see the multipliers above), not because only the first one is "input". They
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

export function calculateCostCents(
  model: string,
  inputTokens: number,
  outputTokens: number,
  // Cache tokens are reported separately from `input_tokens` by the SDK usage
  // object and are billed at different rates (see the multiplier constants).
  // Default to 0 so callers that don't care about caching are unaffected.
  cacheReadInputTokens = 0,
  cacheCreationInputTokens = 0
): number {
  let pricing = MODEL_PRICING[model];
  if (!pricing) {
    pricing = DEFAULT_PRICING;
    // Surface unrecognized models so we can add them to MODEL_PRICING rather than
    // silently billing at the conservative default rate.
    console.warn(
      `[AI] No pricing entry for model "${model}" — falling back to DEFAULT_PRICING ` +
      `($${(DEFAULT_PRICING.inputPerMillion / 100).toFixed(2)}/$${(DEFAULT_PRICING.outputPerMillion / 100).toFixed(2)} per MTok). Add it to MODEL_PRICING.`
    );
  }
  const inputCost = (inputTokens / 1_000_000) * pricing.inputPerMillion;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPerMillion;
  // Cache reads (~0.1x input) and cache writes/creation (~1.25x input) are priced
  // off the per-model input rate. Omitting them undercounts cost for any cached
  // request — the bulk of input tokens on multi-turn sessions land in the cache.
  const cacheReadCost =
    (cacheReadInputTokens / 1_000_000) * pricing.inputPerMillion * CACHE_READ_INPUT_MULTIPLIER;
  const cacheWriteCost =
    (cacheCreationInputTokens / 1_000_000) * pricing.inputPerMillion * CACHE_WRITE_INPUT_MULTIPLIER;
  return Math.round((inputCost + outputCost + cacheReadCost + cacheWriteCost) * 100) / 100;
}

export function calculateCatalogCostCents(
  catalogPricing: CatalogPricingSnapshot,
  inputTokens: number,
  outputTokens: number,
  cacheReadInputTokens = 0,
  cacheCreationInputTokens = 0,
): number {
  const inputCost = (inputTokens / 1_000_000) * catalogPricing.inputCentsPerM;
  const outputCost = (outputTokens / 1_000_000) * catalogPricing.outputCentsPerM;
  const cacheReadCost =
    (cacheReadInputTokens / 1_000_000) * catalogPricing.cacheReadCentsPerM;
  const cacheWriteCost =
    (cacheCreationInputTokens / 1_000_000) * catalogPricing.cacheWriteCentsPerM;
  return Math.round((inputCost + outputCost + cacheReadCost + cacheWriteCost) * 100) / 100;
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
 * Record token usage for a message and update aggregates.
 *
 * `sessionId` is `null` for sessionless flows (e.g. the one-shot catalog AI
 * enrichment, which has no `ai_sessions` row). In that case the per-session
 * totals update is skipped, but the org-budget aggregates (`ai_cost_usage`)
 * are still written so per-org budget enforcement still sees the spend. Passing
 * a non-UUID label as the session id used to throw `invalid input syntax for
 * type uuid` and abort before the aggregate write, silently bypassing budgets
 * (issue #1949).
 */
export async function recordUsage(
  sessionId: string | null,
  orgId: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  isToolExecution: boolean,
  billingSource: AiBillingSource,
  catalogPricing?: CatalogPricingSnapshot,
): Promise<void> {
  const costCents = catalogPricing
    ? calculateCatalogCostCents(catalogPricing, inputTokens, outputTokens)
    : calculateCostCents(model, inputTokens, outputTokens);
  const now = new Date();
  const dailyKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
  const monthlyKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

  // Run queries individually instead of in a transaction to avoid
  // SAVEPOINT errors with the postgres.js driver (postgres@3.4.8).
  // These are additive counters so partial failure is acceptable.
  if (sessionId !== null) {
    try {
      // #2190 — self-contexted: a contextless write under forced RLS silently
      // matches 0 rows AND trips the contextless-write guard (#1375). The
      // wrapper reuses any active ambient context (see checkBillingCredits), so
      // existing in-request callers are unchanged; the fire-and-forget
      // invocation from the sessionless enrichment path (which may run after
      // its caller's context closed) now opens its own short system context.
      await withSystemDbAccessContext(() => db
        .update(aiSessions)
        .set({
          totalInputTokens: sql`${aiSessions.totalInputTokens} + ${inputTokens}`,
          totalOutputTokens: sql`${aiSessions.totalOutputTokens} + ${outputTokens}`,
          totalCostCents: sql`${aiSessions.totalCostCents} + ${costCents}`,
          billingSource,
          turnCount: sql`${aiSessions.turnCount} + 1`,
          lastActivityAt: new Date(),
          updatedAt: new Date()
        })
        .where(eq(aiSessions.id, sessionId)));
    } catch (err) {
      console.error(`[AI] Failed to update session totals for session=${sessionId}, cost=${costCents}:`, err);
      throw err;
    }
  }

  // Update daily/monthly aggregates
  for (const [period, periodKey] of [['daily', dailyKey], ['monthly', monthlyKey]] as const) {
    try {
      // #2190 — self-contexted per upsert (keeps the "partial failure is
      // acceptable" independence of the two periods; see the session update
      // above for the escalation rationale).
      await withSystemDbAccessContext(() => db
        .insert(aiCostUsage)
        .values({
          orgId,
          period,
          periodKey,
          inputTokens,
          outputTokens,
          totalCostCents: costCents,
          sessionCount: 0,
          messageCount: 1,
          toolExecutionCount: isToolExecution ? 1 : 0,
          billingSource,
        })
        .onConflictDoUpdate({
          target: [aiCostUsage.orgId, aiCostUsage.period, aiCostUsage.periodKey],
          set: {
            inputTokens: sql`${aiCostUsage.inputTokens} + ${inputTokens}`,
            outputTokens: sql`${aiCostUsage.outputTokens} + ${outputTokens}`,
            totalCostCents: sql`${aiCostUsage.totalCostCents} + ${costCents}`,
            messageCount: sql`${aiCostUsage.messageCount} + 1`,
            toolExecutionCount: isToolExecution
              ? sql`${aiCostUsage.toolExecutionCount} + 1`
              : aiCostUsage.toolExecutionCount,
            billingSource,
            updatedAt: new Date()
          }
        }));
    } catch (err) {
      console.error(`[AI] Failed to update ${period} aggregate for org=${orgId}, key=${periodKey}, cost=${costCents}:`, err);
      // Continue to attempt the other period
    }
  }

  // Cost anomaly detection (after counter updates)
  checkCostAnomalies(sessionId, orgId, costCents).catch(err => {
    console.error('[AI] Cost anomaly check failed:', err);
  });
}

/**
 * Record usage from the Claude Agent SDK result message.
 *
 * Catalog-backed sessions are always priced from their immutable pricing snapshot.
 * Otherwise, cost comes from the SDK's self-reported `total_cost_usd` when it is
 * present and non-zero. The SDK computes that from its own bundled model→price table,
 * so a model id newer than that table makes it report `total_cost_usd: 0`. To avoid
 * silently recording $0.00 in that case (issue #1326), we fall back to pricing the
 * reported `input_tokens`/`output_tokens` ourselves via MODEL_PRICING. The model id
 * is taken from `result.model` when available, otherwise looked up from the session row.
 */
export async function recordUsageFromSdkResult(
  sessionId: string,
  orgId: string,
  result: {
    total_cost_usd: number;
    usage: {
      input_tokens: number;
      output_tokens: number;
      // Cache tokens are reported separately from input_tokens by the SDK usage
      // object and are billed at different rates. Optional so older/partial usage
      // payloads (and tests) don't have to supply them.
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
    num_turns: number;
    /** Model id the SDK ran with. Used to price tokens when total_cost_usd is 0. */
    model?: string;
    /**
     * Number of tool calls completed during this turn, for the
     * `ai_cost_usage.tool_execution_count` rollup. Defaults to 0 — callers that
     * don't track tool calls (or turns with none) leave the counter untouched.
     */
    toolExecutionCount?: number;
  },
  billingSource: AiBillingSource,
  catalogPricing?: CatalogPricingSnapshot,
): Promise<void> {
  if (!orgId) {
    console.warn(`[AI] Skipping recordUsageFromSdkResult — empty orgId for session=${sessionId}`);
    return;
  }
  const {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_input_tokens: cacheReadTokens = 0,
    cache_creation_input_tokens: cacheCreationTokens = 0,
  } = result.usage;
  const toolExecutionCount = result.toolExecutionCount ?? 0;

  // What the `*_input_tokens` COLUMNS store. Kept distinct from the three
  // variables above, which stay split because each is billed at its own rate.
  const recordedInputTokens = sumInputTokens(result.usage);

  let costCents: number;
  if (catalogPricing) {
    costCents = calculateCatalogCostCents(
      catalogPricing,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
    );
  } else {
    // Prefer the SDK's self-reported cost. Fall back to token-based pricing only when
    // the SDK reports 0/missing cost but actually consumed tokens — this is the case
    // that was silently producing $0.00 sessions (the SDK can't price a model id newer
    // than its bundled table).
    costCents = Math.round(result.total_cost_usd * 100 * 100) / 100; // USD → cents, 2 decimal places
    if (
      costCents <= 0 &&
      (inputTokens > 0 || outputTokens > 0 || cacheReadTokens > 0 || cacheCreationTokens > 0)
    ) {
      const model = result.model ?? (await getSessionModel(sessionId));
      if (model) {
        // Include cache read/creation tokens — pricing only input+output here would
        // systematically undercount cost for cached requests (issue #1326 follow-up).
        costCents = calculateCostCents(
          model,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreationTokens
        );
        console.warn(
          `[AI] SDK reported total_cost_usd=${result.total_cost_usd} for session=${sessionId} ` +
          `(${inputTokens} in / ${outputTokens} out / ${cacheReadTokens} cache-read / ` +
          `${cacheCreationTokens} cache-write tokens). Priced from MODEL_PRICING ` +
          `for model "${model}" → ${costCents} cents.`
        );
      } else {
        console.warn(
          `[AI] SDK reported total_cost_usd=${result.total_cost_usd} for session=${sessionId} ` +
          `with ${inputTokens} in / ${outputTokens} out tokens but no model id available — ` +
          `cannot price tokens, recording 0 cents.`
        );
      }
    }
  }
  const now = new Date();
  const dailyKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
  const monthlyKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

  // Update session totals
  try {
    await db
      .update(aiSessions)
      .set({
        totalInputTokens: sql`${aiSessions.totalInputTokens} + ${recordedInputTokens}`,
        totalOutputTokens: sql`${aiSessions.totalOutputTokens} + ${outputTokens}`,
        totalCostCents: sql`${aiSessions.totalCostCents} + ${costCents}`,
        billingSource,
        turnCount: sql`${aiSessions.turnCount} + ${result.num_turns}`,
        lastActivityAt: now,
        updatedAt: now
      })
      .where(eq(aiSessions.id, sessionId));
  } catch (err) {
    console.error(`[AI] Failed to update session totals (SDK) for session=${sessionId}:`, err);
    throw err;
  }

  // Update daily/monthly aggregates
  for (const [period, periodKey] of [['daily', dailyKey], ['monthly', monthlyKey]] as const) {
    try {
      await db
        .insert(aiCostUsage)
        .values({
          orgId,
          period,
          periodKey,
          inputTokens: recordedInputTokens,
          outputTokens,
          totalCostCents: costCents,
          sessionCount: 0,
          messageCount: 1,
          toolExecutionCount,
          billingSource,
        })
        .onConflictDoUpdate({
          target: [aiCostUsage.orgId, aiCostUsage.period, aiCostUsage.periodKey],
          set: {
            inputTokens: sql`${aiCostUsage.inputTokens} + ${recordedInputTokens}`,
            outputTokens: sql`${aiCostUsage.outputTokens} + ${outputTokens}`,
            totalCostCents: sql`${aiCostUsage.totalCostCents} + ${costCents}`,
            messageCount: sql`${aiCostUsage.messageCount} + 1`,
            // Was missing entirely — every SDK-path turn (the normal chat flow,
            // as opposed to the sessionless recordUsage() path) upserted this row
            // without ever touching tool_execution_count, so it stayed 0 forever
            // even though ai_tool_executions rows were being written correctly.
            toolExecutionCount: sql`${aiCostUsage.toolExecutionCount} + ${toolExecutionCount}`,
            billingSource,
            updatedAt: now
          }
        });
    } catch (err) {
      console.error(`[AI] Failed to update ${period} aggregate (SDK) for org=${orgId}:`, err);
    }
  }

  // Cost anomaly detection
  checkCostAnomalies(sessionId, orgId, costCents).catch(err => {
    console.error('[AI] Cost anomaly check failed (SDK):', err);
  });

  if (billingSource === 'platform') {
    await deductBillingCredits(orgId, costCents);
  }
}

/**
 * Sessionless variant of `recordUsageFromSdkResult`, for SDK loops that have no
 * `ai_sessions` row at all — today the headless agent runner (wave 3c).
 *
 * `recordUsage(null, …)` is NOT a substitute and using it here was a real gap:
 * it re-prices from plain input/output counters, so it drops cache-read and
 * cache-creation tokens (most of a multi-turn agent prompt) and discards the
 * SDK's authoritative cost entirely, and it contains no `deductBillingCredits`
 * call — platform-billed agent traffic never touched the org's prepaid credit
 * balance, leaving BOTH budget gates (`checkBudget` and `checkBillingCredits`)
 * blind to spend they are supposed to cap.
 *
 * Everything a session would have received is still recorded: the org-level
 * `ai_cost_usage` daily/monthly aggregates, the anomaly check, and the credit
 * deduction for platform billing. Only the per-session totals are skipped,
 * because there is no session row to carry them.
 */
export async function recordSessionlessSdkUsage(
  orgId: string,
  result: {
    /**
     * The SDK's authoritative cost, already converted to cents by the caller
     * (which needs it mid-stream for its own per-run budget guard). Priced from
     * tokens here only if it is 0 against a non-zero token count — the #1326
     * "SDK cannot price a model id newer than its bundled table" case.
     */
    costCents: number;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
    /** SDK `num_turns`, summed across the run's result messages. */
    numTurns: number;
    /** Tool calls the run actually executed, for the tool_execution_count rollup. */
    toolExecutionCount?: number;
    /** Model id, for the token-pricing fallback. */
    model?: string;
  },
  billingSource: AiBillingSource,
): Promise<void> {
  if (!orgId) {
    console.warn('[AI] Skipping recordSessionlessSdkUsage — empty orgId');
    return;
  }

  const {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_input_tokens: cacheReadTokens = 0,
    cache_creation_input_tokens: cacheCreationTokens = 0,
  } = result.usage;
  const anyTokens =
    inputTokens > 0 || outputTokens > 0 || cacheReadTokens > 0 || cacheCreationTokens > 0;

  let costCents = result.costCents;
  if (costCents <= 0 && anyTokens && result.model) {
    costCents = calculateCostCents(
      result.model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
    );
  }

  // A cache-only turn (every plain input/output counter 0, the whole prompt
  // served from cache) still COSTS money — gating the write on
  // input/output alone silently dropped those from the org rollup.
  if (!anyTokens && costCents <= 0) return;

  // What the `*_input_tokens` COLUMNS store: the three disjoint input slices
  // summed. Pricing above deliberately keeps them split (different rates).
  const recordedInputTokens = sumInputTokens(result.usage);
  const toolExecutionCount = result.toolExecutionCount ?? 0;
  // One sessionless call covers a whole run, not one message. `num_turns` is
  // the honest message count for it; 1 keeps the counter monotonic when the SDK
  // reports no turns.
  const messageCount = result.numTurns > 0 ? result.numTurns : 1;

  const now = new Date();
  const dailyKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
  const monthlyKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

  for (const [period, periodKey] of [['daily', dailyKey], ['monthly', monthlyKey]] as const) {
    try {
      // Self-contexted per upsert, same as recordUsage: the caller is a BullMQ
      // processor holding no ambient context, and a contextless write under
      // forced RLS matches 0 rows (#2190/#1375).
      await withSystemDbAccessContext(() => db
        .insert(aiCostUsage)
        .values({
          orgId,
          period,
          periodKey,
          inputTokens: recordedInputTokens,
          outputTokens,
          totalCostCents: costCents,
          sessionCount: 0,
          messageCount,
          toolExecutionCount,
          billingSource,
        })
        .onConflictDoUpdate({
          target: [aiCostUsage.orgId, aiCostUsage.period, aiCostUsage.periodKey],
          set: {
            inputTokens: sql`${aiCostUsage.inputTokens} + ${recordedInputTokens}`,
            outputTokens: sql`${aiCostUsage.outputTokens} + ${outputTokens}`,
            totalCostCents: sql`${aiCostUsage.totalCostCents} + ${costCents}`,
            messageCount: sql`${aiCostUsage.messageCount} + ${messageCount}`,
            toolExecutionCount: sql`${aiCostUsage.toolExecutionCount} + ${toolExecutionCount}`,
            billingSource,
            updatedAt: now,
          },
        }));
    } catch (err) {
      console.error(`[AI] Failed to update ${period} aggregate (sessionless SDK) for org=${orgId}:`, err);
      // Continue to attempt the other period.
    }
  }

  checkCostAnomalies(null, orgId, costCents).catch(err => {
    console.error('[AI] Cost anomaly check failed (sessionless SDK):', err);
  });

  if (billingSource === 'platform' && costCents > 0) {
    await deductBillingCredits(orgId, costCents);
  }
}

/**
 * Record usage for a single openai-compatible turn.
 * Cost is calculated from declared per-token pricing (best-effort).
 * No prompt caching equivalent exists on vLLM; the full context is re-sent each turn.
 */
export async function recordOpenAIUsage(
  sessionId: string,
  orgId: string,
  inputTokens: number,
  outputTokens: number,
  costUsd: number,
  billingSource: AiBillingSource,
): Promise<void> {
  if (!orgId) {
    console.warn(`[AI] Skipping recordOpenAIUsage — empty orgId for session=${sessionId}`);
    return;
  }
  const costCents = Math.round(costUsd * 100 * 100) / 100;
  const now = new Date();
  const dailyKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
  const monthlyKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

  try {
    await db
      .update(aiSessions)
      .set({
        totalInputTokens: sql`${aiSessions.totalInputTokens} + ${inputTokens}`,
        totalOutputTokens: sql`${aiSessions.totalOutputTokens} + ${outputTokens}`,
        totalCostCents: sql`${aiSessions.totalCostCents} + ${costCents}`,
        billingSource,
        lastActivityAt: now,
        updatedAt: now,
      })
      .where(eq(aiSessions.id, sessionId));
  } catch (err) {
    console.error(`[AI] Failed to update session totals (OpenAI) for session=${sessionId}:`, err);
    throw err;
  }

  for (const [period, periodKey] of [['daily', dailyKey], ['monthly', monthlyKey]] as const) {
    try {
      await db
        .insert(aiCostUsage)
        .values({
          orgId,
          period,
          periodKey,
          inputTokens,
          outputTokens,
          totalCostCents: costCents,
          sessionCount: 0,
          messageCount: 1,
          toolExecutionCount: 0,
          billingSource,
        })
        .onConflictDoUpdate({
          target: [aiCostUsage.orgId, aiCostUsage.period, aiCostUsage.periodKey],
          set: {
            inputTokens: sql`${aiCostUsage.inputTokens} + ${inputTokens}`,
            outputTokens: sql`${aiCostUsage.outputTokens} + ${outputTokens}`,
            totalCostCents: sql`${aiCostUsage.totalCostCents} + ${costCents}`,
            messageCount: sql`${aiCostUsage.messageCount} + 1`,
            billingSource,
            updatedAt: now,
          },
        });
    } catch (err) {
      console.error(`[AI] Failed to update ${period} aggregate (OpenAI) for org=${orgId}:`, err);
    }
  }

  checkCostAnomalies(sessionId, orgId, costCents).catch(err => {
    console.error('[AI] Cost anomaly check failed (OpenAI):', err);
  });

  if (billingSource === 'platform') {
    await deductBillingCredits(orgId, costCents);
  }
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
 * Check for cost anomalies after recording usage.
 * Logs warnings for sessions consuming too much budget.
 */
async function checkCostAnomalies(
  sessionId: string | null,
  orgId: string,
  costCents: number
): Promise<void> {
  // #2190 — self-contexted: reached fire-and-forget from recordUsage on the
  // (contextless) enrichment path; without a context these reads RLS-filter to
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
}): Promise<void> {
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
      alertThresholdPercents: settings.alertThresholdPercents ?? null,
    });
  }
}

/**
 * Get session history for admin dashboard.
 */
export async function getSessionHistory(orgId: string, options: { limit?: number; offset?: number; flagged?: boolean }): Promise<Array<{
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
 * Get usage summary for an org.
 */
export async function getUsageSummary(orgId: string): Promise<{
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
  /** #4388 W04: the partner's platform-credit balance, as last cached by
   *  checkBillingCreditsDetailed. `null` when billed to the partner's own
   *  key (BYOK — no platform credits apply), when the org has no partner id,
   *  or when nothing has been cached yet (no billing service, or the cache
   *  entry expired/was never written). Never throws. */
  credits: { remaining: number; includedBalance: number; purchasedBalance: number; fetchedAt: string } | null;
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

  const billedTo = await getLlmBillingSourceForOrg(orgId);

  // Only worth a lookup when traffic is actually billed to the partner's own
  // key — platform-key orgs never stamp a catalog_entry_id on their sessions.
  let catalogEndpointName: string | null = null;
  if (billedTo === 'partner_key') {
    const entryId = await getRecentCatalogEntryIdForOrg(orgId);
    if (entryId) catalogEndpointName = await getCatalogEntryName(entryId);
  }

  // #4388 W04: the cached partner credit balance. Only meaningful for
  // platform-billed orgs (a partner_key/BYOK org spends against its own
  // Anthropic account, not platform credits). Wrapped so a Redis outage, a
  // missing/deleted org row, or a corrupt cache entry all degrade to `null`
  // rather than a 500 on /ai/usage.
  let credits: { remaining: number; includedBalance: number; purchasedBalance: number; fetchedAt: string } | null = null;
  if (billedTo === 'platform') {
    try {
      const [org] = await db
        .select({ partnerId: organizations.partnerId })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1);
      const redis = org?.partnerId ? getRedis() : null;
      const raw = redis ? await redis.get(`ai:credits:${org?.partnerId}`) : null;
      if (raw) credits = JSON.parse(raw);
    } catch {
      credits = null;
    }
  }

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
