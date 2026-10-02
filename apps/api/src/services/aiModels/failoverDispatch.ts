/**
 * AI model registry W09 (#7607): dispatch-time failover for one Messages API
 * call (the script reviewer, Office ticket, chat ticket draft, extension
 * content).
 *
 * Funding rules (plan F3–F6), in order, on a classified PRE-OUTPUT provider
 * failure of hop n:
 *   1. the offering cools down (offeringHealth);
 *   2. hop n is settled on ITS OWN binding and reservation (zero tokens: a
 *      status response bills nothing) — never carried into hop n+1;
 *   3. resolveModel is asked again with every tried offering excluded and the
 *      dispatch's first hop as the origin, so the permitted set, live
 *      eligibility, the funding rule (F1) and the connection rule are all
 *      re-checked for hop n+1 (F2);
 *   4. hop n+1 is admitted for ITS funding (credits on platform, caps on
 *      both) and reserved under `<base>:hop:<n+1>` with ITS binding (F3);
 *   5. the surface settles the serving hop on that hop's binding and
 *      reservation (F5); W03's exactly-once platform debit
 *      (`ai-settlement:<reservationId>`) does the rest (F6). Nothing here
 *      debits.
 * Anything else — an unclassified error, an error after output, or a model
 * with nothing configured to fail over to — rethrows the ORIGINAL error with
 * the hop unsettled, so the surface's W03 failure handling is unchanged.
 */
import {
  markAiBudgetReservationIndeterminate,
  reserveAiBudget,
  type AiBudgetNamespace,
  type ClientAiBudgetCaps,
} from '../aiBudgetReservations';
import { checkBudgetDetailed } from '../aiCostTracker';
import { MessageDispatchError, type MessageAttempt } from './connectionFactory';
import { classifyProviderError, hopIdempotencyKey, MAX_FAILOVER_HOP, type ProviderFailureCause } from './failover';
import { captureException } from '../sentry';
import { noteProviderFailure } from './offeringHealth';
import { safeErrorMessage } from './safeDbError';
import type { FailoverOrigin, ResolvedModel, ResolveModelResult } from './resolveModel';
import { settleInvocation } from './settleInvocation';
import { turnBindingFrom, type TurnBinding } from './turnBinding';

export interface FailoverHop {
  /** 0 = the call's own first dispatch. */
  index: number;
  resolved: ResolvedModel;
  binding: TurnBinding;
  reservationId: string;
  idempotencyKey: string;
  /** This hop's own reserved allowance (null = uncapped); size max_tokens from it, never from hop 0's (Codex review 6). */
  reservedCostCents: number | null;
}

/** The first hop's funding/connection: every re-resolution is judged against it (Codex review 4). */
export function failoverOriginOf(resolved: ResolvedModel): FailoverOrigin {
  return { offeringId: resolved.offering.id, funding: resolved.funding, connectionId: resolved.connection.id };
}

export type HopReservation =
  | { ok: true; reservationId: string; reservedCostCents: number | null }
  | { ok: false; reason: 'credits' | 'budget'; message: string };

export type FailoverHopReserver = (resolved: ResolvedModel, binding: TurnBinding, idempotencyKey: string) => Promise<HopReservation>;

export class FailoverExhaustedError extends Error {
  readonly code = 'failover_exhausted' as const;
  constructor(
    readonly lastError: unknown,
    /** Already settled by runWithFailover: the caller must not settle it again. */
    readonly lastHop: FailoverHop,
    readonly stop: 'no_next_hop' | 'admission_denied',
    readonly admissionMessage: string | null = null,
  ) {
    super(stop === 'admission_denied'
      ? `AI failover stopped: ${admissionMessage ?? 'the backup model was not admitted'}`
      : 'AI failover found no other usable model');
    this.name = 'FailoverExhaustedError';
  }
}

/** A failover step failed for an internal reason (DB, binding conflict): logged scrubbed and reported, never swallowed. */
function reportInternalFailure(step: string, hop: FailoverHop, error: unknown): void {
  const message = safeErrorMessage(error);
  console.error('[failover] internal step failed; the dispatch ends without a backup', {
    step, surface: hop.resolved.surface, hop: hop.index, reservationId: hop.reservationId, error: message,
  });
  captureException(new Error(`AI failover ${step} failed: ${message}`), undefined, {
    ...(hop.resolved.orgId ? { org_id: hop.resolved.orgId } : {}), ai_reservation_id: hop.reservationId,
  });
}

export async function runWithFailover<T>(input: {
  first: FailoverHop;
  reResolve: (args: { excludeOfferingIds: string[]; cause: ProviderFailureCause; origin: FailoverOrigin }) => Promise<ResolveModelResult>;
  reserveHop: FailoverHopReserver;
  attempt: (hop: FailoverHop) => Promise<T>;
  settleFailedHop: (hop: FailoverHop, error: unknown) => Promise<void>;
  /** True when the failure came back before ANY provider output (default: true). */
  isPreOutput?: (error: unknown) => boolean;
}): Promise<{ value: T; hop: FailoverHop }> {
  const baseKey = input.first.idempotencyKey;
  const origin = failoverOriginOf(input.first.resolved);
  let hop = input.first;
  const tried: string[] = hop.resolved.offering.id ? [hop.resolved.offering.id] : [];
  for (;;) {
    let error: unknown;
    try {
      return { value: await input.attempt(hop), hop };
    } catch (caught) {
      error = caught;
    }
    const cause = classifyProviderError(error);
    if (cause === null || !(input.isPreOutput?.(error) ?? true)) throw error;
    await noteProviderFailure(hop.resolved, cause);
    if (hop.resolved.failoverRemaining.length === 0 || hop.index + 1 > MAX_FAILOVER_HOP) throw error;

    // F4. From here on every exit is a FailoverExhaustedError, whose contract
    // is "the failed hop is handled": a throw in these internal steps never
    // leaks to the surface with `current` still pointing at a hop it would
    // then settle or release a second time (PR #7775 review).
    try {
      await input.settleFailedHop(hop, error);
    } catch (settleError) {
      // Unknown whether the settle wrote: hold the hop (W03's unknown-outcome state).
      reportInternalFailure('settle_failed_hop', hop, settleError);
      if (hop.resolved.orgId) {
        await markAiBudgetReservationIndeterminate({ orgId: hop.resolved.orgId, reservationId: hop.reservationId })
          .catch((markError: unknown) => reportInternalFailure('mark_failed_hop_indeterminate', hop, markError));
      }
      throw new FailoverExhaustedError(error, hop, 'no_next_hop');
    }
    let next: ResolveModelResult;
    try {
      next = await input.reResolve({ excludeOfferingIds: [...tried], cause, origin });       // F1 vs the origin, F2
    } catch (resolveError) {
      reportInternalFailure('re_resolve', hop, resolveError);
      throw new FailoverExhaustedError(error, hop, 'no_next_hop');
    }
    if (!next.ok || next.offering.id === null || tried.includes(next.offering.id)) {
      throw new FailoverExhaustedError(error, hop, 'no_next_hop');
    }
    const binding = turnBindingFrom(next);
    const index = hop.index + 1;
    const idempotencyKey = hopIdempotencyKey(baseKey, index);
    let reservation: HopReservation;
    try {
      reservation = await input.reserveHop(next, binding, idempotencyKey);                    // F3
    } catch (reserveError) {
      reportInternalFailure('reserve_next_hop', hop, reserveError);
      throw new FailoverExhaustedError(error, hop, 'no_next_hop');
    }
    if (!reservation.ok) throw new FailoverExhaustedError(error, hop, 'admission_denied', reservation.message);
    console.warn('[failover] dispatching the next hop', {
      surface: next.surface, fromOfferingId: hop.resolved.offering.id, toOfferingId: next.offering.id,
      fromFunding: hop.resolved.funding, toFunding: next.funding, cause, hop: index,
    });
    tried.push(next.offering.id);
    hop = {
      index, resolved: next, binding, reservationId: reservation.reservationId, idempotencyKey,
      reservedCostCents: reservation.reservedCostCents,
    };
  }
}

/** F3: admission (credits + caps) for THIS hop's funding, then its reservation with its binding. */
export function reserveFailoverHop(base: {
  orgId: string;
  sessionId?: string | null;
  namespace?: AiBudgetNamespace;
  clientBudget?: ClientAiBudgetCaps;
  maxHoldCents?: number;
}): FailoverHopReserver {
  return async (resolved, binding, idempotencyKey) => {
    const denial = await checkBudgetDetailed(base.orgId, resolved.funding);
    if (denial) return { ok: false, reason: 'credits', message: denial.message };
    const r = await reserveAiBudget({
      orgId: base.orgId,
      idempotencyKey,
      billingSource: resolved.funding,
      binding,
      ...(base.sessionId ? { sessionId: base.sessionId } : {}),
      ...(base.namespace ? { namespace: base.namespace } : {}),
      ...(base.clientBudget ? { clientBudget: base.clientBudget } : {}),
      ...(base.maxHoldCents !== undefined ? { maxHoldCents: base.maxHoldCents } : {}),
    });
    if (r.kind === 'denied') return { ok: false, reason: 'budget', message: r.message };
    return { ok: true, reservationId: r.reservationId, reservedCostCents: r.kind === 'reserved' ? r.reservedCostCents : null };
  };
}

/** F4: a status-response failure billed nothing: a zero-token `error` row on the hop's own reservation. */
export function settleZeroUsageHop(ctx: {
  orgId: string; userId: string | null; sessionId: string | null; agentRunId: string | null; sourceRef: string | null;
}): (hop: FailoverHop) => Promise<void> {
  return async (hop) => {
    await settleInvocation({
      binding: hop.binding,
      orgId: ctx.orgId,
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      agentRunId: ctx.agentRunId,
      sourceRef: ctx.sourceRef,
      usage: [],
      outcome: {
        stopReason: 'error', refused: false, refusalCategory: null, fallbackUsed: false,
        servedModel: hop.binding.wireModel, providerModel: null, sdkReportedCostUsd: null, fastDowngraded: false,
      },
      reservationId: hop.reservationId,
      messageCount: 0,
      toolExecutionCount: 0,
      turnCount: 0,
    });
  };
}

/**
 * The completed (billed) provider responses a failed Messages API dispatch
 * carries: connectionFactory's MessageDispatchError (a refusal answered before
 * its client-side fallback threw, Codex review 3), or a surface error that
 * carries its own `attempts` (Office / ticket draft retry loops).
 */
export function completedAttemptsOf(error: unknown): MessageAttempt[] {
  if (error instanceof MessageDispatchError) return [...error.attempts];
  const attempts = error && typeof error === 'object' ? (error as { attempts?: unknown }).attempts : undefined;
  return Array.isArray(attempts) ? (attempts as MessageAttempt[]) : [];
}

/** Pre-output only when no provider response came back: a burned attempt never fails over. */
export function isPreOutputMessagesFailure(error: unknown): boolean {
  return completedAttemptsOf(error).length === 0;
}
