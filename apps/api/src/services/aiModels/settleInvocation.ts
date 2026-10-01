/**
 * THE billing path (spec §8, quorum #5). Every surface ends here:
 * priceInvocation over the bound rate snapshot → ai_invocations rows → the
 * reservation settlement derives session totals and ai_cost_usage from those
 * rows in ONE transaction (and advances the SDK usage snapshot in it) → the
 * platform credit balance is debited by the same cents, once, under a stable
 * idempotency key. The provider's own cost is copied onto the ledger as
 * telemetry, never billed.
 */
import type { AiSurface } from '@breeze/shared';
import { runOutsideDbContext } from '../../db';
import {
  creditDebitIdempotencyKey,
  markCreditsDebited,
  recordCreditDebitFailure,
  recordCreditDebitRetry,
  recordInvocationsWithRollups,
  settleAiBudgetReservationDurably,
} from '../aiBudgetReservations';
import { debitBillingCredits } from '../aiCostTracker';
import { captureException, captureMessage } from '../sentry';
import type { BilledUsage, SdkUsageNote, SdkUsageSnapshot, SpeedServed, TurnOutcome } from './invocationUsage';
import type { NewInvocation } from './invocationLedgerWrite';
import { getPlatformModelByModelId } from './platformModels';
import { platformRateSnapshot, priceInvocation, type RateSnapshot } from './pricing';
import type { ResolvedModel } from './resolveModel';
import { safeErrorMessage } from './safeDbError';
import type { TurnBinding } from './turnBinding';

/** Server-side web search fee per request (same value as catalogEnrichmentService.ts; Task 13 points it here). */
export const WEB_SEARCH_COST_CENTS = 1;

export interface PricedUsage extends BilledUsage {
  rate: RateSnapshot;
  costCents: number;
  /** The speed actually billed: 'fast' only when served fast AND the snapshot prices fast. */
  appliedSpeed: SpeedServed;
  /** The usage key is neither the bound model nor its refusal fallback (the CLI switched on its own). */
  unboundModel: boolean;
}

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const REPORT_WINDOW_MS = 60_000;

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export function sumCostCents(priced: ReadonlyArray<{ costCents: number | null }>): number {
  return round6(priced.reduce((sum, p) => sum + (p.costCents ?? 0), 0));
}

function boundModels(binding: TurnBinding): Set<string> {
  return new Set([binding.wireModel, ...(binding.refusalFallback ? [binding.refusalFallback.wireModel] : [])]);
}

/**
 * Price each usage row by the model its tokens are attributed to:
 * - the bound model → the bound snapshot; its refusal fallback → that snapshot;
 * - any other key (the CLI's own refusal switch, W05 spike) → that model's
 *   current platform rate when the turn is platform-funded and the registry
 *   prices it (`platformRates`, pre-fetched by settleInvocation and re-checked
 *   inside the settlement transaction), else the bound rate. Never a guess, and
 *   flagged `unboundModel` so the ledger marks it fallbackUsed.
 * Fast is billed only when the provider CONFIRMED it (`speedServed`); the
 * Agent SDK never can, so SDK usage is always standard.
 */
export function priceUsage(
  binding: TurnBinding,
  usage: BilledUsage[],
  opts: { platformRates?: ReadonlyMap<string, RateSnapshot> } = {},
): PricedUsage[] {
  const rows: BilledUsage[] = usage.length > 0
    ? usage
    : [{ model: binding.wireModel, tokens: ZERO, webSearchRequests: 0, speedServed: 'standard', providerModel: null }];
  return rows.map((u) => {
    let rate: RateSnapshot = binding.rateSnapshot;
    let unboundModel = false;
    if (u.model === binding.wireModel) {
      rate = binding.rateSnapshot;
    } else if (binding.refusalFallback && u.model === binding.refusalFallback.wireModel) {
      rate = binding.refusalFallback.rateSnapshot;
    } else {
      unboundModel = true;
      const platform = binding.funding === 'platform' ? opts.platformRates?.get(u.model) : undefined;
      rate = platform ?? binding.rateSnapshot;
      console.warn('[settleInvocation] usage for a model the turn did not bind', {
        bound: binding.wireModel, billed: u.model, rateSource: platform ? 'platform_row' : 'bound_rate',
      });
    }
    let appliedSpeed: SpeedServed = 'standard';
    if (u.speedServed === 'fast') {
      if (rate.option?.key === 'speed:fast') {
        appliedSpeed = 'fast';
      } else {
        // Served fast with no fast rate bound: resolveModel never binds that,
        // so this is a provider surprise. Bill standard (under, not over) and
        // make it visible rather than fail the whole settlement.
        console.warn('[settleInvocation] fast served without a bound fast rate; billed standard', { model: u.model });
      }
    }
    const applied = appliedSpeed === 'fast' ? { speed: 'fast' as const } : {};
    const costCents = round6(priceInvocation(rate, u.tokens, applied) + u.webSearchRequests * WEB_SEARCH_COST_CENTS);
    return { ...u, rate, costCents, appliedSpeed, unboundModel };
  });
}

export function costEstimator(
  resolved: Pick<ResolvedModel, 'rateSnapshot' | 'options'>,
): (inputTokens: number, outputTokens: number) => number {
  return (inputTokens, outputTokens) =>
    priceInvocation(resolved.rateSnapshot, { input: inputTokens, output: outputTokens, cacheRead: 0, cacheWrite: 0 }, resolved.options);
}

export interface SettleInvocationInput {
  binding: TurnBinding;
  orgId: string;
  userId: string | null;
  sessionId: string | null;
  agentRunId: string | null;
  sourceRef: string | null;
  usage: BilledUsage[];
  outcome: TurnOutcome;
  reservationId?: string;
  messageCount?: number;
  toolExecutionCount?: number;
  turnCount?: number;
  /**
   * Agent SDK surfaces (W05 spike): sdkTurnUsage()'s next snapshot for the
   * BREEZE session, advanced in the settlement transaction (so a rolled-back
   * or deferred settlement does not advance it), plus its confidence flags.
   */
  sdkUsage?: {
    sessionId: string;
    nextSnapshot: SdkUsageSnapshot | null;
    usageConfirmed?: boolean;
    usageNote?: SdkUsageNote;
  };
}

export interface SettledInvocation { costCents: number; invocationIds: string[]; deferred: boolean }

/**
 * The cents settleInvocation will bill for this usage (same rate selection,
 * including the platform-rate lookup for unbound models). For consumers that
 * must quote the turn BEFORE settling it — the Office per-user ledger (#5557
 * ordering) and the `done` event — so every consumer reads one number.
 */
export async function quoteInvocationCents(binding: TurnBinding, usage: BilledUsage[]): Promise<number> {
  const platformRates = await loadUnboundPlatformRates(binding, usage);
  return sumCostCents(priceUsage(binding, usage, { platformRates }));
}

export function toNewInvocations(input: SettleInvocationInput, priced: PricedUsage[]): NewInvocation[] {
  const b = input.binding;
  return priced.map((p, index): NewInvocation => {
    // Refusal / fallback labels belong to ONE createMessage call's attempts: a
    // row from a multi-call settlement (a retry loop) is labelled from its own
    // call's outcome and sibling rows, never from the merged turn outcome.
    const outcome = p.callOutcome ?? input.outcome;
    const callRows = p.call === undefined ? priced : priced.filter((x) => x.call === p.call);
    const multi = callRows.length > 1;
    const servedByFallback = p.unboundModel || (outcome.fallbackUsed && p.model !== b.wireModel);
    const refusedLeg = outcome.fallbackUsed && multi && p.model === b.wireModel;
    // The speed the row was BILLED at: a requested 'fast' the provider served
    // as standard is recorded as standard (not applied).
    const optionsSent = b.options.speed !== undefined || p.appliedSpeed === 'fast'
      ? { ...b.options, speed: p.appliedSpeed }
      : b.options;
    return {
      orgId: input.orgId,
      surface: b.surface as AiSurface,
      role: b.role,
      userId: input.userId,
      sessionId: input.sessionId,
      agentRunId: input.agentRunId,
      sourceRef: input.sourceRef,
      offeringId: b.offeringId,
      connectionId: b.connectionId,
      fundingSource: b.funding,
      // requested = the id the tokens are billed under; served = what the
      // provider says it ran (Messages API), so a mismatch stays visible.
      requestedModel: p.model,
      servedModel: p.providerModel ?? p.model,
      optionsSent,
      thinkingModeSent: b.thinkingMode,
      inferenceGeoSent: b.inferenceGeo,
      stopReason: refusedLeg ? 'refusal' : outcome.stopReason,
      refusalCategory: refusedLeg || servedByFallback || outcome.refused ? outcome.refusalCategory : null,
      fallbackUsed: servedByFallback,
      catalogRevisionId: b.catalogRevisionId,
      connectionConfigVersion: b.configVersion,
      tokens: p.tokens,
      rateSnapshot: (p.webSearchRequests > 0
        ? { ...p.rate, serverToolFees: { webSearchRequests: p.webSearchRequests, centsEach: WEB_SEARCH_COST_CENTS } }
        : p.rate) as RateSnapshot,
      costCents: p.costCents,
      chargeable: false, // W10 sets the chargeback snapshot
      sdkReportedCostUsd: index === 0 ? input.outcome.sdkReportedCostUsd : null,
      // W02 wrote 'shadow' rows beside the legacy path; from W03 the ledger is the
      // billing record, and rollups are derived from these rows only.
      ledgerMode: 'authoritative',
      legacyCostCents: null,
    };
  });
}

/** Platform rates for usage keys the binding did not name (see priceUsage). Best effort: a miss bills the bound rate. */
async function loadUnboundPlatformRates(binding: TurnBinding, usage: readonly BilledUsage[]): Promise<Map<string, RateSnapshot>> {
  const rates = new Map<string, RateSnapshot>();
  if (binding.funding !== 'platform') return rates;
  const bound = boundModels(binding);
  for (const model of new Set(usage.map((u) => u.model).filter((m) => !bound.has(m)))) {
    try {
      const row = await runOutsideDbContext(() => getPlatformModelByModelId(model));
      const snapshot = row ? platformRateSnapshot(row) : null;
      if (snapshot) rates.set(model, snapshot);
    } catch (error) {
      console.error('[settleInvocation] platform rate lookup failed; billing the bound rate', {
        model, error: safeErrorMessage(error),
      });
    }
  }
  return rates;
}

type ReportedEventCode = 'ai_usage_snapshot_regressed' | 'ai_credit_debit_rejected' | 'ai_credit_debit_retries_exhausted';
const lastReportedAt = new Map<ReportedEventCode, number>();

/**
 * These conditions can arrive in storms (a rotated billing key rejects every
 * debit), so Sentry gets at most one event per code per window per process.
 * Every occurrence still reaches the server log with its ids.
 */
function shouldReport(eventCode: ReportedEventCode): boolean {
  const now = Date.now();
  const last = lastReportedAt.get(eventCode);
  if (last !== undefined && now - last < REPORT_WINDOW_MS) return false;
  lastReportedAt.set(eventCode, now);
  return true;
}

export function __resetSettleInvocationReportsForTests(): void {
  lastReportedAt.clear();
}

function reportUsageConfidence(input: SettleInvocationInput): void {
  const s = input.sdkUsage;
  if (!s || s.usageConfirmed !== false) return;
  const detail = {
    eventCode: s.usageNote === 'snapshot_regressed' ? 'ai_usage_snapshot_regressed' : 'ai_usage_unconfirmed',
    usageNote: s.usageNote ?? null,
    surface: input.binding.surface,
    orgId: input.orgId,
    sessionId: s.sessionId,
    reservationId: input.reservationId ?? null,
  };
  console.warn(`[settleInvocation] ${detail.eventCode} ${JSON.stringify(detail)}`);
  if (s.usageNote === 'snapshot_regressed') {
    if (shouldReport('ai_usage_snapshot_regressed')) {
      captureMessage('AI SDK usage snapshot regressed; the turn billed zero', { eventCode: 'ai_usage_snapshot_regressed' });
    }
  }
}

export async function settleInvocation(input: SettleInvocationInput): Promise<SettledInvocation> {
  reportUsageConfidence(input);
  const platformRates = await loadUnboundPlatformRates(input.binding, input.usage);
  const priced = priceUsage(input.binding, input.usage, { platformRates });
  const rows = toNewInvocations(input, priced);
  const costCents = sumCostCents(priced);
  const sdkUsage = input.sdkUsage
    ? { sessionId: input.sdkUsage.sessionId, nextSnapshot: input.sdkUsage.nextSnapshot }
    : undefined;

  if (input.reservationId) {
    const result = await settleAiBudgetReservationDurably({
      orgId: input.orgId,
      reservationId: input.reservationId,
      invocations: rows,
      messageCount: input.messageCount ?? 1,
      toolExecutionCount: input.toolExecutionCount ?? 0,
      ...(input.sessionId ? { session: { id: input.sessionId, turnCount: input.turnCount ?? 1 } } : {}),
      ...(sdkUsage ? { sdkUsage } : {}),
    });
    if (result.kind === 'deferred_indeterminate') {
      // Persisted for the sweep, which replays it and then debits.
      return { costCents, invocationIds: [], deferred: true };
    }
    // Review finding 1: only the call that moved the reservation to `settled`
    // debits; 'already_settled' means another call did (and debited).
    if (result.kind === 'settled' && result.creditsDebitDue) {
      await debitSettledCredits({ orgId: input.orgId, reservationId: input.reservationId, costCents: result.actualCostCents });
    }
    return { costCents, invocationIds: result.invocationIds, deferred: false };
  }

  const invocationIds = await recordInvocationsWithRollups({
    orgId: input.orgId,
    invocations: rows,
    sessionId: input.sessionId,
    messageCount: input.messageCount ?? 1,
    toolExecutionCount: input.toolExecutionCount ?? 0,
    turnCount: input.turnCount ?? 1,
    ...(sdkUsage ? { sdkUsage } : {}),
  });
  if (input.binding.funding === 'platform' && costCents > 0 && invocationIds[0]) {
    await debitUnreservedCredits(input.orgId, costCents, `ai-invocation:${invocationIds[0]}`);
  }
  return { costCents, invocationIds, deferred: false };
}

/**
 * Debit a settled reservation's platform spend exactly once (review finding 1),
 * keyed `ai-settlement:<reservation id>`, and record the outcome durably:
 * debited → stamped; 4xx → stamped FAILED (terminal, Sentry
 * `ai_credit_debit_rejected`, operator-visible, never retried); 5xx / 408 /
 * 429 / transport → counted and left for the sweep to retry under the SAME
 * key, until MAX_CREDIT_DEBIT_ATTEMPTS. `costCents` must be the amount the
 * reservation stored (the sweep re-sends exactly that; the billing service
 * 409s a key reused with another amount). Never throws: the AI turn already
 * happened and settled.
 */
export async function debitSettledCredits(input: { orgId: string; reservationId: string; costCents: number }): Promise<void> {
  try {
    const result = await debitBillingCredits(input.orgId, input.costCents, {
      idempotencyKey: creditDebitIdempotencyKey(input.reservationId),
    });
    switch (result.kind) {
      case 'debited':
        await markCreditsDebited(input.reservationId);
        return;
      case 'not_configured':
        return;
      case 'rejected': {
        await recordCreditDebitFailure(input.reservationId, result.code);
        console.error('[AI] platform credit debit REJECTED; stamped failed for an operator', {
          orgId: input.orgId, reservationId: input.reservationId, costCents: input.costCents, code: result.code,
        });
        if (shouldReport('ai_credit_debit_rejected')) {
          captureMessage('AI platform credit debit rejected; spend not debited', {
            eventCode: 'ai_credit_debit_rejected', tags: billingTags(input.orgId, result.status),
          });
        }
        return;
      }
      case 'retryable': {
        const { attempts, exhausted } = await recordCreditDebitRetry(input.reservationId, result.code);
        console.warn('[AI] platform credit debit not confirmed; the sweep retries it under the same key', {
          orgId: input.orgId, reservationId: input.reservationId, code: result.code, attempts, exhausted,
        });
        if (exhausted) {
          if (shouldReport('ai_credit_debit_retries_exhausted')) {
            captureMessage('AI platform credit debit never confirmed; retries exhausted', {
              eventCode: 'ai_credit_debit_retries_exhausted', tags: billingTags(input.orgId, result.status),
            });
          }
        }
        return;
      }
    }
  } catch (error) {
    const message = safeErrorMessage(error);
    console.error('[AI] platform credit debit bookkeeping failed; the sweep retries it', {
      orgId: input.orgId, reservationId: input.reservationId, error: message,
    });
    captureException(new Error(`AI credit debit bookkeeping failed: ${message}`));
  }
}

function billingTags(orgId: string, status: number | null): Record<string, string> {
  return { org_id: orgId, ai_billing_http_status: status === null ? 'none' : String(status) };
}

/**
 * A platform debit with no reservation to stamp. Keyed by the call's first
 * ledger row, so a repeat of THIS call cannot double-charge, but there is no
 * durable retry: a failure is logged and reported for reconciliation.
 */
async function debitUnreservedCredits(orgId: string, costCents: number, idempotencyKey: string): Promise<void> {
  try {
    const result = await debitBillingCredits(orgId, costCents, { idempotencyKey });
    if (result.kind === 'debited' || result.kind === 'not_configured') return;
    console.error('[AI] unreserved platform credit debit did not land', { orgId, costCents, code: result.code, kind: result.kind });
    if (shouldReport('ai_credit_debit_rejected')) {
      captureMessage('AI platform credit debit (no reservation) did not land', {
        eventCode: 'ai_credit_debit_rejected', tags: billingTags(orgId, result.status),
      });
    }
  } catch (error) {
    const message = safeErrorMessage(error);
    console.error('[AI] unreserved platform credit debit failed', { orgId, error: message });
    captureException(new Error(`AI credit debit failed: ${message}`));
  }
}
