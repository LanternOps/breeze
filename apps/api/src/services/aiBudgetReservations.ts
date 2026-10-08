import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { pgErrorCode } from '@breeze/shared/pgErrors';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { captureException, captureMessage } from './sentry';
import { tightenLockTimeout } from '../db/lockTimeout';
import { getEffectiveAiBudget } from './effectiveSettings';
import type { AiBillingSource } from './aiCostTracker';
import { TRANSIENT_FAILOVER_CAUSES } from './aiModels/failover';
import { readConnectionOfferingRate } from './aiModels/connectionOfferingRate';
import { recordInvocation, type NewInvocation } from './aiModels/invocationLedgerWrite';
import { stampChargeback } from './aiChargeback/stampChargeback';
import { parseSdkUsageSnapshot, sdkUsageHighWater, type SdkUsageSnapshot } from './aiModels/invocationUsage';
import { getPlatformModelByModelId } from './aiModels/platformModels';
import { platformRateSnapshot } from './aiModels/pricing';
import { safeErrorMessage } from './aiModels/safeDbError';
import { parseTurnBinding, stableJson, type TurnBinding } from './aiModels/turnBinding';
import { CHAT_TURN_KEY_PREFIX } from './aiModels/modelTransition';


/** Local copy of aiCostTracker.isBillingServiceConfigured (importing it would create a module cycle). */
function billingServiceConfigured(): boolean {
  return Boolean(process.env.BILLING_SERVICE_URL && process.env.BILLING_SERVICE_API_KEY);
}

export type { AiBillingSource } from './aiCostTracker';

export type AiBudgetReservationStatus =
  | 'active' | 'settled' | 'indeterminate' | 'released' | 'expired';
/**
 * Which cap a reservation is admitted against. One ledger, two surfaces
 * (#5557): `technician` is the operator-facing AI (chat, helper, script
 * builder, agent runs); `client` is the Office add-in end-user surface, which
 * carries an ADDITIONAL per-org sub-cap from `client_ai_org_policies` on top of
 * the organization's AI budget.
 *
 * Settled spend is shared — a client turn already writes `ai_cost_usage`
 * through `settleInvocation` — so the organization cap is GLOBAL and
 * its held-sum predicates stay deliberately cross-namespace. The namespace only
 * selects the extra client sub-cap and the holds that count against it. Making
 * the org cap namespace-filtered would let client spend settle into a cap its
 * own holds never counted toward.
 */
export type AiBudgetNamespace = 'technician' | 'client';

export type AiBudgetDenialReason =
  | 'ai_disabled'
  | 'daily_budget'
  | 'monthly_budget'
  | 'client_daily_budget'
  | 'client_monthly_budget'
  | 'client_daily_budget_in_flight'
  | 'client_monthly_budget_in_flight'
  /**
   * The cap is not spent — it is held by another dispatch that has not settled
   * yet. A reservation takes the WHOLE remaining cap (see `reserveAiBudget`),
   * so a budgeted organization runs one AI request at a time. Saying "budget
   * exhausted" here would be a lie the operator cannot act on.
   */
  | 'daily_budget_in_flight'
  | 'monthly_budget_in_flight';

/**
 * How long a reservation may hold the organization's cap before the sweep
 * releases it. An `active` row belongs to a dispatch that should have settled
 * within one provider turn; an `indeterminate` row may still be settled by a
 * late completion, so it keeps its claim far longer.
 */
export const AI_BUDGET_RESERVATION_ACTIVE_TTL_MS = 30 * 60 * 1000;
export const AI_BUDGET_RESERVATION_INDETERMINATE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Bound every `organizations FOR UPDATE` in this module. Admission serializes
 * on that row, so without a bound a queue of waiters each pins a pooled
 * connection for as long as the holder runs — turning contention on one
 * organization into an API-wide pool outage. 55P03 is converted to
 * {@link AiBudgetLockTimeoutError} so callers fail fast and visibly.
 */
export const AI_BUDGET_LOCK_TIMEOUT_MS = 5_000;

/**
 * Settlement, marking and release get a much longer bound than admission, and
 * the asymmetry is the point. A blocked ADMISSION should fail fast — the caller
 * has spent nothing and a 503 costs only a retry. A blocked SETTLEMENT is on
 * the money path: the provider has already been paid, so giving up cheaply
 * loses the spend from `ai_cost_usage` and strands the reservation holding the
 * organization's whole cap. Wait, then retry, and only then fall back.
 */
export const AI_BUDGET_SETTLEMENT_LOCK_TIMEOUT_MS = 30_000;

export class AiBudgetLockTimeoutError extends Error {
  readonly code = 'AI_BUDGET_LOCK_TIMEOUT';
  constructor(operation: string, boundMs: number, options?: { cause?: unknown }) {
    super(
      `AI budget ${operation} could not acquire the organization lock within ${boundMs}ms`,
      options,
    );
    this.name = 'AiBudgetLockTimeoutError';
  }
}

/** Narrow an unknown error to the lock-timeout case a route answers 503 for. */
export function isAiBudgetLockTimeout(error: unknown): error is AiBudgetLockTimeoutError {
  return error instanceof AiBudgetLockTimeoutError;
}

/** The client-AI sub-cap, read from `client_ai_org_policies`. null = unlimited. */
export interface ClientAiBudgetCaps {
  dailyBudgetCents: number | null;
  monthlyBudgetCents: number | null;
}

export interface ReserveAiBudgetInput {
  orgId: string;
  idempotencyKey: string;
  billingSource: AiBillingSource;
  sessionId?: string | null;
  /** Defaults to 'technician' so every pre-#5557 call site keeps its behaviour. */
  namespace?: AiBudgetNamespace;
  /** REQUIRED when namespace is 'client'; rejected otherwise. */
  clientBudget?: ClientAiBudgetCaps;
  /**
   * Upper bound on the amount THIS reservation may hold, in addition to the
   * daily/monthly remaining-cap fence. Omitted (the pre-existing default)
   * still reserves the whole remaining cap, which is the general JD L-2 hold
   * on this module — every caller with a real per-request ceiling should pass
   * it so one dispatch does not serialize every other AI surface in a capped
   * org, and so an indeterminate outcome only holds that ceiling for its
   * extended TTL rather than the whole remaining budget. Never widens a hold:
   * when the true remaining amount is tighter than the ceiling, the tighter
   * figure still wins.
   */
  maxHoldCents?: number;
  /**
   * AI model registry W03 (spec §9.2 bullet 1): the turn binding. Written onto
   * the reservation (`model_binding`) and stamped onto the session in the SAME
   * transaction as the claim, so binding and reservation land together or not
   * at all. Settlement then bills only a rate bound here.
   */
  binding?: TurnBinding;
  /**
   * W05 (#7603): the chat messages route only. Enforced inside the claim
   * transaction, before the session stamp (see {@link SessionSwitchGuard}).
   */
  sessionSwitchGuard?: SessionSwitchGuard;
  now?: Date;
}

/**
 * A stable-key replay tried to re-bind a reservation whose outcome is (or may
 * be) recorded already: settled, not active, or carrying a persisted deferred
 * settlement. Re-binding it would bill a model nobody is about to run.
 */
export class AiBudgetBindingConflictError extends Error {
  readonly code = 'binding_conflict' as const;
  constructor() {
    super('AI budget reservation is already bound to a turn whose outcome is recorded');
    this.name = 'AiBudgetBindingConflictError';
  }
}

/**
 * W05 (#7603), spike constraint 3: a chat session's model and options change
 * only BETWEEN turns, and a switch is claimed only against the turn it was
 * planned (and fit-checked) on. Refused claims roll back whole, the
 * reservation insert included.
 */
export class AiBudgetSessionBusyError extends Error {
  readonly code = 'turn_in_progress' as const;
  constructor(message = 'A reply is still running in this chat, or one just finished. Send again to continue.') {
    super(message);
    this.name = 'AiBudgetSessionBusyError';
  }
}

/** Passed by the chat messages route only. One-shots (ticket draft, continuation) are never guarded. */
export interface SessionSwitchGuard {
  /** readPreviousTurn().reservationId the turn was planned against, or null when there was none. */
  expectedPreviousChatReservationId: string | null;
}

/**
 * Review finding 2 (#7700): the reservation carries a persisted deferred
 * settlement. Its outcome is recorded (just not yet applied), so a stable-key
 * replay may not take the hold back for a new dispatch, and no settlement other
 * than that pending one may land on it — either would overwrite or orphan the
 * spend the sweep is about to replay.
 */
export class AiBudgetPendingSettlementError extends Error {
  readonly code = 'pending_settlement' as const;
  constructor(reservationId: string, action: 'reserve' | 'settle') {
    super(action === 'reserve'
      ? `AI budget reservation ${reservationId} carries a pending settlement and cannot be reused`
      : `AI budget reservation ${reservationId} carries a different pending settlement`);
    this.name = 'AiBudgetPendingSettlementError';
  }
}

/**
 * N11: `status` is the literal `'active'`, not a union. `existingResult` is the
 * ONLY producer and it throws for every other status, so a widened union made
 * callers write an unreachable `status !== 'active'` branch that read like a
 * real failure mode. Keep it exact and the dead branches stay deleted.
 */
type ReservationIdentity = {
  reservationId: string;
  dailyPeriodKey: string;
  monthlyPeriodKey: string;
  status: 'active';
};

export type ReserveAiBudgetResult =
  | ({ kind: 'unlimited' } & ReservationIdentity)
  | ({ kind: 'reserved'; reservedCostCents: number } & ReservationIdentity)
  | { kind: 'denied'; reason: AiBudgetDenialReason; message: string };

/** W05 spike: the Agent SDK usage snapshot a settlement advances (see invocationUsage.ts). */
export interface SettleSdkUsage {
  /** The BREEZE session (ai_sessions.id) the snapshot belongs to. */
  sessionId: string;
  /** null = leave the stored snapshot as it is. */
  nextSnapshot: SdkUsageSnapshot | null;
  /**
   * The turn re-baselined a regressed snapshot (usageNote `snapshot_regressed`,
   * review finding 3): store `nextSnapshot` as-is, even below the stored one.
   * Every other advance is a monotone high-water merge.
   */
  rebaseline?: boolean;
  /**
   * Review S10: the snapshot a re-baselining turn was computed against. The
   * re-baseline is written only while the stored snapshot still equals it; a
   * deferred re-baseline replayed after a newer turn advanced the session
   * would otherwise move the snapshot back under that turn and bill its tokens
   * again. Absent = no check (round-A behaviour).
   */
  baseSnapshot?: SdkUsageSnapshot | null;
}

export interface SettleAiBudgetReservationInput {
  orgId: string;
  reservationId: string;
  /**
   * W03: the priced ledger rows. When present they ARE the settlement: the
   * totals below are derived from them (and must then be omitted), each row is
   * inserted in this transaction, and every row must carry a rate the
   * reservation's turn binding fixed. Without them, the legacy numeric totals
   * are required — see settlementTotals for why that form is still accepted.
   */
  invocations?: NewInvocation[];
  actualCostCents?: number;
  inputTokens?: number;
  outputTokens?: number;
  messageCount?: number;
  toolExecutionCount?: number;
  session?: { id: string; turnCount?: number };
  /** Advanced in the settlement transaction, never on a rolled-back one. */
  sdkUsage?: SettleSdkUsage;
  settledAt?: Date;
}

export type SettleAiBudgetReservationResult = {
  kind: 'settled' | 'already_settled';
  reservationId: string;
  actualCostCents: number;
  /** Ledger rows THIS call inserted ([] on a replay). */
  invocationIds: string[];
  billingSource: AiBillingSource;
  /**
   * True only on the call that moved the reservation to `settled` with ledger
   * rows of platform spend: that call owns the keyed credit debit.
   */
  creditsDebitDue: boolean;
};

export type DeferredAiBudgetSettlement = {
  kind: 'deferred_indeterminate';
  reservationId: string;
  /** The settle input was written to pending_settlement; the sweep replays it. */
  persisted: boolean;
};

type ReservationRow = Record<string, unknown> & {
  id: string;
  org_id: string;
  idempotency_key: string;
  session_id: string | null;
  billing_source: AiBillingSource;
  namespace: AiBudgetNamespace;
  daily_period_key: string;
  monthly_period_key: string;
  uncapped: boolean;
  reserved_cost_cents: string | number;
  actual_cost_cents: string | number | null;
  status: AiBudgetReservationStatus;
  settlement_fingerprint: string | null;
  expires_at: string | Date;
  model_binding?: unknown;
  pending_settlement?: unknown;
};

type UsageAndReservationsRow = Record<string, unknown> & {
  daily_usage: string | number;
  monthly_usage: string | number;
  daily_reserved: string | number;
  monthly_reserved: string | number;
  client_daily_usage: string | number;
  client_monthly_usage: string | number;
  client_daily_reserved: string | number;
  client_monthly_reserved: string | number;
};

export interface AiBudgetOutputCapInput {
  /** Entire serialized request payload, including system and tool instructions. */
  prompt: string;
  requestedMaxOutputTokens: number;
  budgetCents: number | undefined;
  calculateCostCents: (inputTokens: number, outputTokens: number) => number;
}

const MONEY_SCALE = 1_000_000;
const MAX_MONEY_CENTS = 99_999_999_999_999;

/**
 * Derive a fail-closed output ceiling for direct provider calls.
 *
 * UTF-8 bytes are a conservative upper bound for provider input tokens. The
 * fixed allowance covers message framing that is not present in the serialized
 * prompt. A caller with an unlimited reservation keeps its requested ceiling.
 */
export function maxOutputTokensForAiBudget(input: AiBudgetOutputCapInput): number | null {
  if (!Number.isSafeInteger(input.requestedMaxOutputTokens) || input.requestedMaxOutputTokens < 1) {
    throw new Error('requestedMaxOutputTokens must be a positive safe integer');
  }
  if (input.budgetCents === undefined) return input.requestedMaxOutputTokens;
  if (!Number.isFinite(input.budgetCents) || input.budgetCents < 0) {
    throw new Error('budgetCents must be a finite non-negative amount');
  }

  const conservativeInputTokens = Buffer.byteLength(input.prompt, 'utf8') + 256;
  if (input.calculateCostCents(conservativeInputTokens, 1) > input.budgetCents) return null;

  let low = 1;
  let high = input.requestedMaxOutputTokens;
  while (low < high) {
    const midpoint = Math.ceil((low + high) / 2);
    if (input.calculateCostCents(conservativeInputTokens, midpoint) <= input.budgetCents) {
      low = midpoint;
    } else {
      high = midpoint - 1;
    }
  }
  return low;
}

function rows<T>(result: unknown): T[] {
  const value = (result as { rows?: T[] }).rows ?? result;
  return Array.isArray(value) ? value : [];
}

function periodKeys(now: Date): { daily: string; monthly: string } {
  if (!Number.isFinite(now.getTime())) throw new Error('AI budget reservation time must be valid');
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return {
    daily: `${now.getUTCFullYear()}-${month}-${String(now.getUTCDate()).padStart(2, '0')}`,
    monthly: `${now.getUTCFullYear()}-${month}`,
  };
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function moneyString(value: number, label: string): string {
  if (!Number.isFinite(value) || value < 0 || value > MAX_MONEY_CENTS) {
    throw new Error(`${label} must be a finite non-negative monetary amount`);
  }
  return (Math.round(value * MONEY_SCALE) / MONEY_SCALE).toFixed(6);
}

function validateIdentity(input: ReserveAiBudgetInput): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.orgId)) {
    throw new Error('orgId must be a UUID');
  }
  if (input.sessionId !== undefined && input.sessionId !== null
      && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.sessionId)) {
    throw new Error('sessionId must be a UUID or null');
  }
  if (input.idempotencyKey.length < 1 || input.idempotencyKey.length > 200) {
    throw new Error('idempotencyKey must contain 1-200 characters');
  }
  // Fail loudly rather than silently admitting a client turn against the
  // organization cap alone — that is exactly the #5557 bypass this closes.
  const namespace = input.namespace ?? 'technician';
  if (namespace === 'client' && !input.clientBudget) {
    throw new Error('clientBudget is required for a client-namespace reservation');
  }
  if (namespace !== 'client' && input.clientBudget) {
    throw new Error('clientBudget is only meaningful for a client-namespace reservation');
  }
  if (input.maxHoldCents !== undefined
      && (!Number.isFinite(input.maxHoldCents) || input.maxHoldCents <= 0)) {
    throw new Error('maxHoldCents must be a finite positive amount');
  }
}

/**
 * Give the reservation its own short transaction even when called from a
 * request-wide DB context. The org lock must commit before provider dispatch;
 * retaining it across a network request would serialize spend but make the
 * transaction itself the availability bottleneck.
 *
 * SYSTEM scope, always — this is a pool-exhaustion fix, not a convenience
 * (review B2). Re-entering the caller's ORGANIZATION context made
 * `getEffectiveAiBudget` -> `readWithPartnerAxisVisibility`
 * (db/partnerAxisRead.ts) take its own escape hatch, opening a THIRD pooled
 * connection while this one still held `organizations FOR UPDATE`. Three
 * connections per admission against a pool of 30 means ~15 concurrent AI
 * requests wedge the entire API. Under system scope that helper short-circuits
 * and joins this transaction, so an admission costs the request's connection
 * plus exactly one more.
 *
 * Escaping RLS is safe for THIS ledger specifically because every statement
 * below is hard-pinned to `input.orgId`, which the caller derived from the
 * verified auth context (never from request input), and because the rows are
 * the server's own accounting — no caller-supplied predicate reaches them. The
 * forced-RLS policies remain the guarantee for every other reader of the table.
 */
function inReservationTransaction<T>(label: string, fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn, label));
}

/**
 * 55P03 = lock_not_available, i.e. `lock_timeout` fired.
 *
 * `pgErrorCode` and not `err.code`: Drizzle wraps the driver error, so the
 * SQLSTATE lives on `.cause` (sometimes nested further). Reading `.code`
 * directly matches only an unwrapped driver error — which is exactly the shape
 * a hand-built test fixture has and the shape production never produces, so the
 * bound would have looked tested and still failed open into a 500.
 */
function isLockNotAvailable(error: unknown): boolean {
  return pgErrorCode(error) === '55P03';
}

/**
 * Take the organization row lock that serializes admission and settlement,
 * bounded so contention fails fast instead of pinning a pooled connection.
 *
 * The bound is not restored afterwards: this transaction is opened by
 * {@link inReservationTransaction}, does nothing else, and commits within a few
 * statements, so there is no caller work left for the tighter value to govern.
 */
async function lockOrganizationRow(
  orgId: string,
  operation: string,
  boundMs: number,
): Promise<void> {
  await tightenLockTimeout(db as unknown as { execute(q: unknown): Promise<unknown> }, boundMs);
  let locked;
  try {
    locked = rows<{ id: string }>(await db.execute<{ id: string }>(sql`
      SELECT id FROM organizations WHERE id = ${orgId}::uuid FOR UPDATE
    `))[0];
  } catch (error) {
    if (isLockNotAvailable(error)) {
      throw new AiBudgetLockTimeoutError(operation, boundMs, { cause: error });
    }
    throw error;
  }
  if (!locked) throw new Error('Organization not found or not visible');
}

function denial(reason: AiBudgetDenialReason, capCents?: number): ReserveAiBudgetResult {
  if (reason === 'ai_disabled') {
    return { kind: 'denied', reason, message: 'AI features are disabled for this organization' };
  }
  // S4: an in-flight hold is not exhaustion. A reservation takes the whole
  // remaining cap, so the second concurrent request for a budgeted org is
  // denied after $0 of settled spend. Telling that caller their budget is
  // "exhausted" sends them to the billing page for a problem that clears in
  // seconds.
  if (reason === 'daily_budget_in_flight' || reason === 'monthly_budget_in_flight') {
    return {
      kind: 'denied',
      reason,
      message: "Another AI request is in flight against this organization's budget; retry shortly",
    };
  }
  if (reason === 'client_daily_budget_in_flight' || reason === 'client_monthly_budget_in_flight') {
    return {
      kind: 'denied',
      reason,
      message: 'Another AI request is in flight against your organization\u2019s budget; retry shortly',
    };
  }
  if (reason === 'client_daily_budget' || reason === 'client_monthly_budget') {
    const clientPeriod = reason === 'client_daily_budget' ? 'Daily' : 'Monthly';
    return {
      kind: 'denied',
      reason,
      // Wording matches the pre-#5557 checkClientBudget strings the add-in
      // already surfaces: this is an end user, not a technician.
      message: `${clientPeriod} AI budget for your organization has been reached `
        + `($${((capCents ?? 0) / 100).toFixed(2)}). Contact your IT provider to raise it.`,
    };
  }
  const period = reason === 'daily_budget' ? 'Daily' : 'Monthly';
  return {
    kind: 'denied',
    reason,
    message: `${period} AI budget exhausted ($${((capCents ?? 0) / 100).toFixed(2)})`,
  };
}

function existingResult(row: ReservationRow): ReserveAiBudgetResult {
  if (row.status === 'indeterminate') {
    throw new Error(`AI budget reservation ${row.id} has an indeterminate provider outcome`);
  }
  if (row.status === 'expired') {
    throw new Error(`AI budget reservation ${row.id} expired before it was settled`);
  }
  if (row.status !== 'active') {
    throw new Error(`AI budget reservation ${row.id} is already ${row.status}`);
  }
  const identity: ReservationIdentity = {
    reservationId: row.id,
    dailyPeriodKey: row.daily_period_key,
    monthlyPeriodKey: row.monthly_period_key,
    status: 'active',
  };
  return row.uncapped
    ? { kind: 'unlimited', ...identity }
    : { kind: 'reserved', ...identity, reservedCostCents: Number(row.reserved_cost_cents) };
}

/**
 * The session half of the turn claim: the offering, options and logical model
 * the session is now bound to. Runs inside the reservation transaction; a
 * missing session (or a rejected composite FK) throws and rolls the claim back.
 * A binding with no offering (none today) stamps nothing.
 */
async function stampSessionBinding(sessionId: string, orgId: string, binding: TurnBinding): Promise<void> {
  if (!binding.offeringId) return;
  // W09 (#7607, D6): a hop that served because the session's own choice was
  // TRANSIENTLY failing (cooldown, 429/529/5xx, key/quota) does not replace
  // that choice; the next turn retries it (the Agent SDK's own fallbackModel
  // semantics). A failover because the choice is gone ('ineligible') stamps,
  // like W03's bounded fallback. The existence check the UPDATE gave is kept.
  if (binding.failover && TRANSIENT_FAILOVER_CAUSES.has(binding.failover.cause)) {
    const exists = rows<{ id: string }>(await db.execute<{ id: string }>(sql`
      SELECT id FROM ai_sessions WHERE id = ${sessionId}::uuid AND org_id = ${orgId}::uuid
    `))[0];
    if (!exists) throw new Error('AI session not found in reservation organization');
    return;
  }
  const stamped = rows<{ id: string }>(await db.execute<{ id: string }>(sql`
    UPDATE ai_sessions
    SET offering_id = ${binding.offeringId}::uuid,
        offering_partner_id = ${binding.partnerId}::uuid,
        options = ${JSON.stringify(binding.options)}::jsonb,
        model = ${binding.logicalModel},
        billing_source = ${binding.funding},
        updated_at = now()
    WHERE id = ${sessionId}::uuid AND org_id = ${orgId}::uuid
    RETURNING id
  `))[0];
  if (!stamped) throw new Error('AI session not found in reservation organization');
}

/**
 * W05 (#7603) between-turns guard. Runs inside the reservation transaction,
 * under the org admission lock, BEFORE the session stamp — so a refusal
 * (AiBudgetSessionBusyError) rolls back the claim whole: no reservation row,
 * no stamp.
 */
async function assertSessionSwitchAllowed(
  sessionId: string,
  orgId: string,
  binding: TurnBinding,
  claimingReservationId: string,
  guard: SessionSwitchGuard,
): Promise<void> {
  // Lock the session row inside the claim transaction (claims are already
  // serialized per org by the admission lock; the row lock makes this exact).
  const current = rows<{ offering_id: string | null; options: unknown; billing_source: string }>(await db.execute(sql`
    SELECT offering_id, options, billing_source FROM ai_sessions
    WHERE id = ${sessionId}::uuid AND org_id = ${orgId}::uuid
    FOR UPDATE
  `))[0];
  if (!current) throw new Error('AI session not found in reservation organization');

  // (a) Generation (Codex review finding 4): the newest OTHER chat-turn claim
  // must be the one the plan read. If another turn was claimed meanwhile, the
  // transcript the fit check counted (and the carried rates) are stale. Same
  // row AND the same answer as readPreviousTurn (modelTransition.ts): a newest
  // row whose binding does not parse reads as "no previous turn" there, so it
  // must here too — otherwise every later claim on the session is refused.
  const newestRow = rows<{ id: string; model_binding: unknown }>(await db.execute<{ id: string; model_binding: unknown }>(sql`
    SELECT id, model_binding FROM ai_budget_reservations
    WHERE org_id = ${orgId}::uuid AND session_id = ${sessionId}::uuid
      AND starts_with(idempotency_key, ${CHAT_TURN_KEY_PREFIX})
      AND model_binding IS NOT NULL AND status <> 'released'
      AND id <> ${claimingReservationId}::uuid
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `))[0];
  const newestId = newestRow && parseTurnBinding(newestRow.model_binding) ? newestRow.id : null;
  if (newestId !== guard.expectedPreviousChatReservationId) throw new AiBudgetSessionBusyError();

  // (b) Between turns (Codex review finding 9: options and funding count,
  // not only the offering): a claim that changes what the session is stamped
  // with is refused while another chat turn's reservation is still active.
  const changes = current.offering_id !== binding.offeringId
    || stableJson(current.options ?? null) !== stableJson(binding.options)
    || current.billing_source !== binding.funding;
  if (!changes) return;
  // A deferred settlement (pending_settlement set, status still 'active' until
  // the sweep replays it) belongs to a FINISHED turn: not in flight. Same
  // predicate as hasActiveChatTurn (modelTransition.ts).
  const inFlight = rows<{ id: string }>(await db.execute<{ id: string }>(sql`
    SELECT id FROM ai_budget_reservations
    WHERE org_id = ${orgId}::uuid AND session_id = ${sessionId}::uuid
      AND starts_with(idempotency_key, ${CHAT_TURN_KEY_PREFIX})
      AND status = 'active' AND expires_at > now()
      AND pending_settlement IS NULL
      AND id <> ${claimingReservationId}::uuid
    LIMIT 1
  `))[0];
  if (inFlight) throw new AiBudgetSessionBusyError();
}

/**
 * Atomically reserves the org's entire finite remaining daily/monthly budget.
 * This is intentionally conservative: an unpriced or unexpectedly long call
 * cannot race sibling calls through the cap. Callers must settle the actual
 * usage, mark an unknown outcome indeterminate, or release only when provider
 * dispatch is proven not to have happened.
 */
export async function reserveAiBudget(input: ReserveAiBudgetInput): Promise<ReserveAiBudgetResult> {
  validateIdentity(input);
  const now = input.now ?? new Date();
  const keys = periodKeys(now);
  const sessionId = input.sessionId ?? null;
  const namespace: AiBudgetNamespace = input.namespace ?? 'technician';
  const clientCaps = namespace === 'client' ? input.clientBudget! : null;

  // ONE CLOCK, and it is Postgres's. `now` (injectable, used above for the
  // period keys) is the API host's wall clock; `expires_at`, the sweep's
  // `expires_at <= now()` and `expired_at` are all evaluated in the database.
  // Mixing them means a host with even seconds of drift either frees a cap
  // early or holds one past its window, and the two would disagree about the
  // same row. Interval, not a literal, so the TTL constant stays the source.
  const activeTtlSeconds = AI_BUDGET_RESERVATION_ACTIVE_TTL_MS / 1000;

  return inReservationTransaction('aiBudgetReservations.reserve', async () => {
    await lockOrganizationRow(input.orgId, 'admission', AI_BUDGET_LOCK_TIMEOUT_MS);

    const existing = rows<ReservationRow>(await db.execute<ReservationRow>(sql`
      SELECT id, org_id, idempotency_key, session_id, billing_source, namespace,
             daily_period_key, monthly_period_key, uncapped,
             reserved_cost_cents, actual_cost_cents, status, settlement_fingerprint,
             expires_at, model_binding, pending_settlement
      FROM ai_budget_reservations
      WHERE org_id = ${input.orgId}::uuid AND idempotency_key = ${input.idempotencyKey}
      FOR UPDATE
    `))[0];
    if (input.binding && input.binding.funding !== input.billingSource) {
      throw new Error('Reservation billing source does not match the turn binding');
    }
    if (existing) {
      if (existing.billing_source !== input.billingSource
        || existing.session_id !== sessionId
        || existing.namespace !== namespace) {
        throw new Error('AI budget reservation idempotency key conflicts with another dispatch');
      }
      // Review finding 2 (#7700): whatever the binding, a reservation whose
      // settlement is persisted-but-pending belongs to the turn that produced it.
      if (existing.pending_settlement !== null && existing.pending_settlement !== undefined) {
        throw new AiBudgetPendingSettlementError(existing.id, 'reserve');
      }
      // Review finding 4: a stable-key retry (agent run, script review attempt)
      // gets back the reservation of a dispatch that never completed. Its old
      // binding may predate a rate or offering change, and settlement would
      // then reject the new rows and leak the hold. Re-bind it here, before
      // anything is dispatched — but never one whose outcome is (or may be)
      // recorded.
      if (input.binding && stableJson(parseTurnBinding(existing.model_binding)) !== stableJson(input.binding)) {
        if (existing.status !== 'active' || existing.settlement_fingerprint !== null) {
          throw new AiBudgetBindingConflictError();
        }
        await db.execute(sql`
          UPDATE ai_budget_reservations SET model_binding = ${JSON.stringify(input.binding)}::jsonb, updated_at = now()
          WHERE id = ${existing.id}::uuid
          RETURNING id
        `);
        if (sessionId) {
          if (input.sessionSwitchGuard) {
            await assertSessionSwitchAllowed(sessionId, input.orgId, input.binding, existing.id, input.sessionSwitchGuard);
          }
          await stampSessionBinding(sessionId, input.orgId, input.binding);
        }
      }
      return existingResult(existing);
    }

    if (sessionId) {
      const session = rows<{ id: string }>(await db.execute<{ id: string }>(sql`
        SELECT id FROM ai_sessions
        WHERE id = ${sessionId}::uuid AND org_id = ${input.orgId}::uuid
      `))[0];
      if (!session) throw new Error('AI session not found in reservation organization');
    }

    // Called after the org row lock so budget admission and all sibling
    // reservations for this org serialize against one stable lock target.
    const budget = await getEffectiveAiBudget(input.orgId);
    if (!budget.enabled) return denial('ai_disabled');

    const orgUncapped = budget.dailyBudgetCents === null && budget.monthlyBudgetCents === null;
    const clientUncapped = !clientCaps
      || (clientCaps.dailyBudgetCents === null && clientCaps.monthlyBudgetCents === null);
    const uncapped = orgUncapped && clientUncapped;
    let reservedCostCents = 0;
    if (!uncapped) {
      // B3: the reserved sums are TIME-BOUNDED. A row whose window has closed no
      // longer holds capacity here even if the sweep has not relabelled it yet,
      // so a crashed dispatch cannot zero the tenant's monthly budget until the
      // 1st. The sweep does the relabelling (and the reporting); this predicate
      // is what makes admission correct in the gap between the two.
      const usage = rows<UsageAndReservationsRow>(await db.execute<UsageAndReservationsRow>(sql`
        SELECT
          COALESCE((SELECT total_cost_cents::numeric FROM ai_cost_usage
                    WHERE org_id = ${input.orgId}::uuid AND period = 'daily'
                      AND period_key = ${keys.daily}), 0)::text AS daily_usage,
          COALESCE((SELECT total_cost_cents::numeric FROM ai_cost_usage
                    WHERE org_id = ${input.orgId}::uuid AND period = 'monthly'
                      AND period_key = ${keys.monthly}), 0)::text AS monthly_usage,
          COALESCE((SELECT sum(reserved_cost_cents) FROM ai_budget_reservations
                    WHERE org_id = ${input.orgId}::uuid
                      AND daily_period_key = ${keys.daily}
                      AND status IN ('active', 'indeterminate')
                      AND expires_at > now()), 0)::text AS daily_reserved,
          COALESCE((SELECT sum(reserved_cost_cents) FROM ai_budget_reservations
                    WHERE org_id = ${input.orgId}::uuid
                      AND monthly_period_key = ${keys.monthly}
                      AND status IN ('active', 'indeterminate')
                      AND expires_at > now()), 0)::text AS monthly_reserved,
          -- #5557: the client sub-cap. Settled client spend is summed across
          -- every portal user in the org (client_ai_usage is per-user), and the
          -- in-flight side counts ONLY client-namespace holds — a technician
          -- hold must not close the add-in surface.
          COALESCE((SELECT sum(total_cost_cents::numeric) FROM client_ai_usage
                    WHERE org_id = ${input.orgId}::uuid AND period = 'daily'
                      AND period_key = ${keys.daily}), 0)::text AS client_daily_usage,
          COALESCE((SELECT sum(total_cost_cents::numeric) FROM client_ai_usage
                    WHERE org_id = ${input.orgId}::uuid AND period = 'monthly'
                      AND period_key = ${keys.monthly}), 0)::text AS client_monthly_usage,
          COALESCE((SELECT sum(reserved_cost_cents) FROM ai_budget_reservations
                    WHERE org_id = ${input.orgId}::uuid
                      AND namespace = 'client'
                      AND daily_period_key = ${keys.daily}
                      AND status IN ('active', 'indeterminate')
                      AND expires_at > now()), 0)::text AS client_daily_reserved,
          COALESCE((SELECT sum(reserved_cost_cents) FROM ai_budget_reservations
                    WHERE org_id = ${input.orgId}::uuid
                      AND namespace = 'client'
                      AND monthly_period_key = ${keys.monthly}
                      AND status IN ('active', 'indeterminate')
                      AND expires_at > now()), 0)::text AS client_monthly_reserved
      `))[0];
      if (!usage) throw new Error('Failed to read AI budget usage');

      // Existing aggregate rows predate this fence. Treat any malformed
      // negative legacy total as zero; it must never manufacture capacity.
      const dailyUsed = Math.max(0, Number(usage.daily_usage));
      const monthlyUsed = Math.max(0, Number(usage.monthly_usage));
      const dailyHeld = Math.max(0, Number(usage.daily_reserved));
      const monthlyHeld = Math.max(0, Number(usage.monthly_reserved));
      const dailyRemaining = budget.dailyBudgetCents === null
        ? Number.POSITIVE_INFINITY
        : budget.dailyBudgetCents - dailyUsed - dailyHeld;
      const monthlyRemaining = budget.monthlyBudgetCents === null
        ? Number.POSITIVE_INFINITY
        : budget.monthlyBudgetCents - monthlyUsed - monthlyHeld;
      // S4: settled spend alone still under the cap means the shortfall came
      // from a live hold, not from money actually spent. Report which.
      if (dailyRemaining <= 0) {
        const cap = budget.dailyBudgetCents ?? 0;
        return dailyHeld > 0 && cap - dailyUsed > 0
          ? denial('daily_budget_in_flight')
          : denial('daily_budget', cap);
      }
      if (monthlyRemaining <= 0) {
        const cap = budget.monthlyBudgetCents ?? 0;
        return monthlyHeld > 0 && cap - monthlyUsed > 0
          ? denial('monthly_budget_in_flight')
          : denial('monthly_budget', cap);
      }
      // Load-bearing: the TIGHTER of the two caps. Using dailyRemaining alone
      // lets a large daily allowance overrun a small monthly one.
      reservedCostCents = Math.min(dailyRemaining, monthlyRemaining);

      // JD L-2: bound the hold to the caller's own request ceiling — never
      // widens it. This is what keeps one dispatch from reserving the org's
      // ENTIRE remaining cap (and, via the same reserved_cost_cents row,
      // holding all of it through an indeterminate outcome's extended TTL)
      // when its own request never needed more than a fraction of it.
      if (input.maxHoldCents !== undefined) {
        reservedCostCents = Math.min(reservedCostCents, input.maxHoldCents);
      }

      // #5557: the client sub-cap narrows further, never widens. An org with no
      // AI budget at all still gets an atomic fence here whenever the add-in
      // policy carries one.
      if (clientCaps && !clientUncapped) {
        const clientDailyUsed = Math.max(0, Number(usage.client_daily_usage));
        const clientMonthlyUsed = Math.max(0, Number(usage.client_monthly_usage));
        const clientDailyHeld = Math.max(0, Number(usage.client_daily_reserved));
        const clientMonthlyHeld = Math.max(0, Number(usage.client_monthly_reserved));
        const clientDailyRemaining = clientCaps.dailyBudgetCents === null
          ? Number.POSITIVE_INFINITY
          : clientCaps.dailyBudgetCents - clientDailyUsed - clientDailyHeld;
        const clientMonthlyRemaining = clientCaps.monthlyBudgetCents === null
          ? Number.POSITIVE_INFINITY
          : clientCaps.monthlyBudgetCents - clientMonthlyUsed - clientMonthlyHeld;
        if (clientDailyRemaining <= 0) {
          const cap = clientCaps.dailyBudgetCents ?? 0;
          return clientDailyHeld > 0 && cap - clientDailyUsed > 0
            ? denial('client_daily_budget_in_flight')
            : denial('client_daily_budget', cap);
        }
        if (clientMonthlyRemaining <= 0) {
          const cap = clientCaps.monthlyBudgetCents ?? 0;
          return clientMonthlyHeld > 0 && cap - clientMonthlyUsed > 0
            ? denial('client_monthly_budget_in_flight')
            : denial('client_monthly_budget', cap);
        }
        reservedCostCents = Math.min(
          reservedCostCents,
          clientDailyRemaining,
          clientMonthlyRemaining,
        );
      }
    }

    const inserted = rows<ReservationRow>(await db.execute<ReservationRow>(sql`
      INSERT INTO ai_budget_reservations (
        org_id, idempotency_key, session_id, billing_source, namespace,
        daily_period_key, monthly_period_key, uncapped, reserved_cost_cents,
        model_binding, expires_at
      ) VALUES (
        ${input.orgId}::uuid, ${input.idempotencyKey}, ${sessionId}::uuid, ${input.billingSource},
        ${namespace},
        ${keys.daily}, ${keys.monthly}, ${uncapped},
        ${moneyString(reservedCostCents, 'reservedCostCents')}::numeric,
        ${input.binding ? JSON.stringify(input.binding) : null}::jsonb,
        now() + make_interval(secs => ${activeTtlSeconds})
      )
      RETURNING id, org_id, idempotency_key, session_id, billing_source, namespace,
                daily_period_key, monthly_period_key, uncapped,
                reserved_cost_cents, actual_cost_cents, status, settlement_fingerprint,
                expires_at
    `))[0];
    if (!inserted) throw new Error('Failed to create AI budget reservation');
    // Spec §9.2 bullet 1: the turn claim binds offering + options + rate +
    // reservation atomically. A failure here (e.g. the composite
    // (offering_id, offering_partner_id) FK) rolls the reservation back too.
    if (input.binding && sessionId) {
      // W05: the between-turns guard runs before the stamp; a refusal rolls
      // this insert back with it (same transaction).
      if (input.sessionSwitchGuard) {
        await assertSessionSwitchAllowed(sessionId, input.orgId, input.binding, inserted.id, input.sessionSwitchGuard);
      }
      await stampSessionBinding(sessionId, input.orgId, input.binding);
    }
    return existingResult(inserted);
  });
}

type SettlementTotals = { actualCostCents: number; inputTokens: number; outputTokens: number };

function settlementFingerprint(
  input: SettleAiBudgetReservationInput,
  totals: SettlementTotals,
  normalizedCost: string,
): string {
  const canonical = JSON.stringify({
    actualCostCents: normalizedCost,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    messageCount: input.messageCount ?? 1,
    toolExecutionCount: input.toolExecutionCount ?? 0,
    sessionId: input.session?.id ?? null,
    sessionTurnCount: input.session?.turnCount ?? 1,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** Same semantics as sumInputTokens(): the *_input_tokens columns hold all three input slices. */
function ledgerTotals(invocations: readonly NewInvocation[]): SettlementTotals {
  return {
    actualCostCents: invocations.reduce((sum, r) => sum + Number(r.costCents ?? 0), 0),
    inputTokens: invocations.reduce((sum, r) => sum + r.tokens.input + r.tokens.cacheRead + r.tokens.cacheWrite, 0),
    outputTokens: invocations.reduce((sum, r) => sum + r.tokens.output, 0),
  };
}

function settlementTotals(input: SettleAiBudgetReservationInput): SettlementTotals {
  if (input.invocations) {
    if (input.actualCostCents !== undefined || input.inputTokens !== undefined || input.outputTokens !== undefined) {
      throw new Error('settleAiBudgetReservation takes invocations OR explicit totals, not both');
    }
    for (const row of input.invocations) {
      if (row.orgId !== input.orgId) throw new Error('Settlement invocation belongs to another organization');
      if (row.costCents === null || !Number.isFinite(row.costCents)) throw new Error('Settlement invocation is unpriced');
    }
    return ledgerTotals(input.invocations);
  }
  // Explicit numeric totals: no live caller writes this form any more (every
  // settlement goes through settleInvocation with priced invocations; W06
  // deleted the env-only OpenAI-compatible chat runtime, the last one). It is
  // KEPT because that runtime could defer a settlement into
  // `pending_settlement` with explicit totals, and replayPendingAiSettlements
  // replays such rows through here; refusing them would strand the spend.
  // Follow-up: once no live (non-dead) pending_settlement row lacks
  // `invocations` in any deployment, delete this branch.
  if (input.actualCostCents === undefined || input.inputTokens === undefined || input.outputTokens === undefined) {
    throw new Error('settleAiBudgetReservation needs invocations or explicit totals');
  }
  return { actualCostCents: input.actualCostCents, inputTokens: input.inputTokens, outputTokens: input.outputTokens };
}

function stripFees(snapshot: unknown): unknown {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  const { serverToolFees: _fees, ...rest } = snapshot as Record<string, unknown>;
  return rest;
}

function sameJson(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}

/**
 * A settlement may only bill a rate the turn claim bound (spec §9.2, §8): the
 * primary or the refusal-fallback snapshot, or (W05) a carried snapshot for its
 * own model key. One exception, from the W05 spike:
 * the CLI can switch a turn to a model the binding never named (its own
 * refusal fallback). That row is accepted only when flagged fallbackUsed and
 * priced at exactly that model's CURRENT rate for the turn's funding, re-read
 * here inside the transaction: on a platform turn its platform row; on a BYOK
 * turn (#7773) its enabled, priced offering on the binding's own connection,
 * through readConnectionOfferingRate on THIS transaction's connection (never
 * loadOfferingCandidate, which would open a second pooled connection).
 */
async function assertInvocationsMatchBinding(binding: TurnBinding, invocations: readonly NewInvocation[]): Promise<void> {
  const boundModels = new Set([binding.wireModel, ...(binding.refusalFallback ? [binding.refusalFallback.wireModel] : [])]);
  for (const row of invocations) {
    if (row.offeringId !== binding.offeringId || row.fundingSource !== binding.funding) {
      throw new Error('Settlement rate does not match the turn binding');
    }
    const rate = stripFees(row.rateSnapshot);
    if (sameJson(rate, binding.rateSnapshot)) continue;
    if (binding.refusalFallback && sameJson(rate, binding.refusalFallback.rateSnapshot)) continue;
    // W05: a model this session switched away from on the SAME connection —
    // its late delta (spike Q6) bills at the rate it was bound with. Keyed on
    // requestedModel: toNewInvocations stores the usage key there.
    const carried = binding.carriedRates?.find((c) => c.wireModel === row.requestedModel);
    if (carried && sameJson(rate, carried.rateSnapshot)) continue;
    if (row.fallbackUsed && binding.funding === 'platform' && !boundModels.has(row.requestedModel)
        && (rate as { source?: unknown } | null)?.source === 'platform') {
      const platform = await getPlatformModelByModelId(row.requestedModel);
      const current = platform ? platformRateSnapshot(platform) : null;
      if (current && sameJson(rate, current)) continue;
    }
    const rateSource = (rate as { source?: unknown } | null)?.source;
    if (row.fallbackUsed && binding.funding === 'partner_key' && !boundModels.has(row.requestedModel)
        && (rateSource === 'offering' || rateSource === 'linked_platform')) {
      const current = await readConnectionOfferingRate({
        partnerId: binding.partnerId, connectionId: binding.connectionId,
        connectionKind: binding.connectionKind, model: row.requestedModel,
      });
      if (current.rate && sameJson(rate, current.rate)) continue;
      // The offering was repriced, disabled or removed since the turn priced
      // this row; the throw below is generic, so say what the re-read found.
      console.warn('[aiBudgetReservations] unbound BYOK rate no longer matches its connection offering; settlement rejected', {
        eventCode: 'ai_unbound_byok_rate_rejected', model: row.requestedModel, connectionId: binding.connectionId,
        offeringId: binding.offeringId, reason: current.rate ? 'rate_changed' : current.reason,
        rowRateSource: rateSource, currentRateSource: current.rate?.source ?? null,
      });
    }
    throw new Error('Settlement rate does not match the turn binding');
  }
}

/**
 * The session totals and both `ai_cost_usage` periods, derived from ONE set of
 * numbers (the ledger rows' totals on the W03 path), in the caller's
 * transaction.
 */
async function applyUsageRollups(input: {
  orgId: string;
  sessionId: string | null;
  billingSource: AiBillingSource;
  keys: { daily: string; monthly: string };
  cost: string;
  inputTokens: number;
  outputTokens: number;
  messageCount: number;
  toolExecutionCount: number;
  turnCount: number;
  at: Date;
}): Promise<void> {
  if (input.sessionId) {
    const updatedSession = rows<{ id: string }>(await db.execute<{ id: string }>(sql`
      UPDATE ai_sessions
      SET total_input_tokens = total_input_tokens + ${input.inputTokens},
          total_output_tokens = total_output_tokens + ${input.outputTokens},
          total_cost_cents = total_cost_cents + ${input.cost}::numeric,
          billing_source = ${input.billingSource},
          turn_count = turn_count + ${input.turnCount},
          last_activity_at = ${input.at.toISOString()}::timestamptz,
          updated_at = ${input.at.toISOString()}::timestamptz
      WHERE id = ${input.sessionId}::uuid AND org_id = ${input.orgId}::uuid
      RETURNING id
    `))[0];
    if (!updatedSession) throw new Error('AI session not found in settlement organization');
  }

  for (const [period, key] of [
    ['daily', input.keys.daily],
    ['monthly', input.keys.monthly],
  ] as const) {
    await db.execute(sql`
      INSERT INTO ai_cost_usage (
        org_id, period, period_key, input_tokens, output_tokens,
        total_cost_cents, session_count, message_count, tool_execution_count,
        billing_source, updated_at
      ) VALUES (
        ${input.orgId}::uuid, ${period}, ${key}, ${input.inputTokens}, ${input.outputTokens},
        ${input.cost}::numeric, 0, ${input.messageCount}, ${input.toolExecutionCount},
        ${input.billingSource}, ${input.at.toISOString()}::timestamptz
      )
      ON CONFLICT (org_id, period, period_key) DO UPDATE SET
        input_tokens = ai_cost_usage.input_tokens + EXCLUDED.input_tokens,
        output_tokens = ai_cost_usage.output_tokens + EXCLUDED.output_tokens,
        total_cost_cents = ai_cost_usage.total_cost_cents + EXCLUDED.total_cost_cents,
        message_count = ai_cost_usage.message_count + EXCLUDED.message_count,
        tool_execution_count = ai_cost_usage.tool_execution_count + EXCLUDED.tool_execution_count,
        billing_source = EXCLUDED.billing_source,
        updated_at = EXCLUDED.updated_at
    `);
  }
}

/**
 * Advance the session's SDK usage snapshot inside the caller's transaction, as
 * a component-wise high-water mark: an unchanged snapshot (Task 5 returns the
 * previous one for an aborted/empty turn) writes nothing, and an older replay
 * can never move it backwards. The exception is a `rebaseline` (a regressed
 * turn, review finding 3), stored as-is so the counters' restart sticks. A session that is gone is logged, not fatal:
 * failing here would lose the whole settlement over a billing aid.
 */
async function advanceSdkUsageSnapshot(orgId: string, sdkUsage: SettleSdkUsage, reservationId: string | null = null): Promise<void> {
  if (!sdkUsage.nextSnapshot) return;
  const next = parseSdkUsageSnapshot(sdkUsage.nextSnapshot);
  if (!next) throw new Error('Malformed SDK usage snapshot');
  const current = rows<{ sdk_usage_snapshot: unknown }>(await db.execute<{ sdk_usage_snapshot: unknown }>(sql`
    SELECT sdk_usage_snapshot FROM ai_sessions
    WHERE id = ${sdkUsage.sessionId}::uuid AND org_id = ${orgId}::uuid
    FOR UPDATE
  `))[0];
  if (!current) {
    console.warn('[AI] SDK usage snapshot not advanced: session not found in settlement organization', {
      orgId, sessionId: sdkUsage.sessionId,
    });
    return;
  }
  const stored = parseSdkUsageSnapshot(current.sdk_usage_snapshot);
  if (sdkUsage.rebaseline === true && reservationId) {
    // Several deferred re-baselines on one session (each regressed against the
    // same stored snapshot) replay oldest first. Only the NEWEST may land: an
    // older one would leave the snapshot below a reading that was already
    // billed, and the next turn's delta would bill it again.
    const newer = rows<{ id: string }>(await db.execute<{ id: string }>(sql`
      SELECT other.id FROM ai_budget_reservations other, ai_budget_reservations me
      WHERE me.id = ${reservationId}::uuid
        AND other.org_id = ${orgId}::uuid
        AND other.id <> me.id
        AND other.pending_settlement IS NOT NULL
        AND other.pending_settlement_dead_at IS NULL
        AND other.status <> 'settled'
        AND other.pending_settlement -> 'sdkUsage' ->> 'sessionId' = ${sdkUsage.sessionId}
        AND (other.pending_settlement -> 'sdkUsage' ->> 'rebaseline')::boolean IS TRUE
        AND other.created_at > me.created_at
      LIMIT 1
    `));
    if (newer.length > 0) {
      console.warn('[AI] SDK usage re-baseline superseded by a newer pending re-baseline; not applied', {
        orgId, sessionId: sdkUsage.sessionId,
      });
      return;
    }
  }
  if (sdkUsage.rebaseline === true && sdkUsage.baseSnapshot !== undefined) {
    const base = sdkUsage.baseSnapshot === null ? null : parseSdkUsageSnapshot(sdkUsage.baseSnapshot);
    if (!sameJson(stored, base)) {
      // A newer turn settled since this one read its base (typically: this is
      // a deferred re-baseline replayed late). Its snapshot is the truth now;
      // the ledger rows of this settlement still land.
      console.warn('[AI] stale SDK usage re-baseline not applied; the session snapshot moved since the turn read it', {
        orgId, sessionId: sdkUsage.sessionId,
      });
      return;
    }
  }
  const merged = stored && sdkUsage.rebaseline !== true ? sdkUsageHighWater(stored, next) : next;
  if (stored && sameJson(stored, merged)) return;
  await db.execute(sql`
    UPDATE ai_sessions SET sdk_usage_snapshot = ${JSON.stringify(merged)}::jsonb
    WHERE id = ${sdkUsage.sessionId}::uuid AND org_id = ${orgId}::uuid
    RETURNING id
  `);
}

/**
 * The SDK usage snapshot the NEXT turn of a breeze session bills against
 * (W05 spike; called by the surfaces before `sdkTurnUsage`). It is the stored
 * snapshot merged with any settlement still PENDING for the session: a turn
 * whose settlement was deferred by lock contention has been priced but not yet
 * applied, and billing the next turn's delta against the older snapshot would
 * bill that usage twice when the sweep replays it. A DEAD pending settlement
 * (finding 5) will never be applied, so it is not merged. Nor is a pending
 * RE-BASELINE (review S10): the next turn bills against the stored snapshot
 * (it regresses too and re-baselines itself, billing its own usage), and its
 * settlement moves the stored snapshot, so the late replay of the older
 * re-baseline sees a changed base and leaves the snapshot alone.
 */
export async function readSdkUsageSnapshot(input: { orgId: string; sessionId: string }): Promise<SdkUsageSnapshot | null> {
  return inReservationTransaction('aiBudgetReservations.readSdkUsageSnapshot', async () => {
    const session = rows<{ sdk_usage_snapshot: unknown }>(await db.execute<{ sdk_usage_snapshot: unknown }>(sql`
      SELECT sdk_usage_snapshot FROM ai_sessions
      WHERE id = ${input.sessionId}::uuid AND org_id = ${input.orgId}::uuid
    `))[0];
    let snapshot = parseSdkUsageSnapshot(session?.sdk_usage_snapshot);
    const pending = rows<{ snapshot: unknown; rebaseline: boolean | null }>(await db.execute<{ snapshot: unknown; rebaseline: boolean | null }>(sql`
      SELECT pending_settlement -> 'sdkUsage' -> 'nextSnapshot' AS snapshot,
             (pending_settlement -> 'sdkUsage' ->> 'rebaseline')::boolean AS rebaseline
      FROM ai_budget_reservations
      WHERE org_id = ${input.orgId}::uuid
        AND pending_settlement IS NOT NULL
        AND pending_settlement_dead_at IS NULL
        AND status <> 'settled'
        AND pending_settlement -> 'sdkUsage' ->> 'sessionId' = ${input.sessionId}
    `));
    for (const row of pending) {
      if (row.rebaseline === true) continue;
      const p = parseSdkUsageSnapshot(row.snapshot);
      if (p) snapshot = snapshot ? sdkUsageHighWater(snapshot, p) : p;
    }
    return snapshot;
  });
}

/**
 * Settle actual usage and every durable aggregate in one transaction.
 *
 * W03: with `invocations`, the ledger rows are inserted HERE (the ambient db
 * is this transaction) and the session / `ai_cost_usage` increments are
 * derived from exactly those rows, so the rollups cannot disagree with the
 * ledger. The same transaction advances the SDK usage snapshot, clears any
 * pending (deferred) settlement and, for platform spend, marks the keyed
 * credit debit as due — returned as `creditsDebitDue` to the one call that
 * performed the transition.
 */
export async function settleAiBudgetReservation(
  input: SettleAiBudgetReservationInput,
): Promise<SettleAiBudgetReservationResult> {
  const totals = settlementTotals(input);
  const cost = moneyString(totals.actualCostCents, 'actualCostCents');
  const inputTokens = nonNegativeInteger(totals.inputTokens, 'inputTokens');
  const outputTokens = nonNegativeInteger(totals.outputTokens, 'outputTokens');
  const messageCount = nonNegativeInteger(input.messageCount ?? 1, 'messageCount');
  const toolExecutionCount = nonNegativeInteger(input.toolExecutionCount ?? 0, 'toolExecutionCount');
  const turnCount = nonNegativeInteger(input.session?.turnCount ?? 1, 'session.turnCount');
  const settledAt = input.settledAt ?? new Date();
  if (!Number.isFinite(settledAt.getTime())) throw new Error('settledAt must be valid');
  const fingerprint = settlementFingerprint(input, totals, cost);

  return inReservationTransaction('aiBudgetReservations.settle', async () => {
    // W10 (#7608): stamp the chargeback snapshot in THIS transaction (the ledger
    // write), before the org lock so the card read never extends its hold.
    // `input` itself stays unstamped: it is what settlementFingerprint hashed and
    // what persistPendingSettlement stores, so a replay is stamped at replay.
    const stamped = input.invocations ? await stampChargeback(input.orgId, input.invocations) : undefined;
    await lockOrganizationRow(input.orgId, 'settlement', AI_BUDGET_SETTLEMENT_LOCK_TIMEOUT_MS);

    const reservation = rows<ReservationRow>(await db.execute<ReservationRow>(sql`
      SELECT id, org_id, idempotency_key, session_id, billing_source, namespace,
             daily_period_key, monthly_period_key, uncapped,
             reserved_cost_cents, actual_cost_cents, status, settlement_fingerprint,
             expires_at, model_binding, pending_settlement
      FROM ai_budget_reservations
      WHERE id = ${input.reservationId}::uuid AND org_id = ${input.orgId}::uuid
      FOR UPDATE
    `))[0];
    if (!reservation) throw new Error('AI budget reservation not found or not visible');
    if (reservation.status === 'settled') {
      if (reservation.settlement_fingerprint !== fingerprint) {
        throw new Error('Conflicting settlement for AI budget reservation');
      }
      return {
        kind: 'already_settled',
        reservationId: reservation.id,
        actualCostCents: Number(reservation.actual_cost_cents),
        invocationIds: [],
        billingSource: reservation.billing_source,
        creditsDebitDue: false,
      };
    }
    if (reservation.status === 'released') {
      throw new Error('Released AI budget reservation cannot be settled');
    }
    // Review finding 2 (#7700): a persisted deferred settlement is the outcome
    // of record. Only that settlement (the sweep's replay, or the deferring
    // caller retrying the same input) may clear it; anything else would
    // silently overwrite the spend it holds.
    if (reservation.pending_settlement !== null && reservation.pending_settlement !== undefined) {
      const pending = revivePendingSettlement(reservation.pending_settlement, reservation);
      const pendingTotals = settlementTotals(pending);
      const pendingFingerprint = settlementFingerprint(
        pending, pendingTotals, moneyString(pendingTotals.actualCostCents, 'actualCostCents'),
      );
      if (pendingFingerprint !== fingerprint) {
        throw new AiBudgetPendingSettlementError(reservation.id, 'settle');
      }
    }
    // B3(c): an `expired` reservation is still settleable. Expiry only means it
    // stopped HOLDING capacity; the provider may still report real spend
    // afterwards and that spend must reach `ai_cost_usage`. Double-charging is
    // prevented by the `settled` fingerprint check above, not by the status.
    if (input.session && reservation.session_id !== input.session.id) {
      throw new Error('Settlement session does not match AI budget reservation');
    }
    if (!reservation.session_id && input.session) {
      throw new Error('Sessionless AI budget reservation cannot update a session');
    }
    if (reservation.session_id && !input.session) {
      throw new Error('Session-bound AI budget reservation requires session settlement');
    }

    const invocationIds: string[] = [];
    if (input.invocations) {
      if (input.invocations.some((row) => row.fundingSource !== reservation.billing_source)) {
        throw new Error('Settlement invocation funding does not match the reservation billing source');
      }
      const binding = parseTurnBinding(reservation.model_binding);
      if (binding) await assertInvocationsMatchBinding(binding, input.invocations);
      for (const row of stamped!) {
        // Ambient db = this transaction (P10): the ledger row commits or rolls
        // back with the rollups derived from it below.
        invocationIds.push(await recordInvocation(row));
      }
    }

    await applyUsageRollups({
      orgId: input.orgId,
      sessionId: input.session?.id ?? null,
      billingSource: reservation.billing_source,
      keys: { daily: reservation.daily_period_key, monthly: reservation.monthly_period_key },
      cost,
      inputTokens,
      outputTokens,
      messageCount,
      toolExecutionCount,
      turnCount,
      at: settledAt,
    });

    if (input.sdkUsage) await advanceSdkUsageSnapshot(input.orgId, input.sdkUsage, input.reservationId);

    // Only a LEDGER settlement of platform spend owes a keyed debit; the legacy
    // recorders deduct for themselves, so their settlements never set this.
    // With no billing service configured (self-hosted) nothing is owed: marking
    // the row due would leave a backlog that a later billing enablement debits.
    const creditsDebitDue = input.invocations !== undefined
      && reservation.billing_source === 'platform'
      && Number(cost) > 0
      && billingServiceConfigured();
    const settled = rows<{ id: string }>(await db.execute<{ id: string }>(sql`
      UPDATE ai_budget_reservations
      SET status = 'settled', actual_cost_cents = ${cost}::numeric,
          settlement_fingerprint = ${fingerprint},
          settled_at = ${settledAt.toISOString()}::timestamptz,
          pending_settlement = NULL,
          credits_debit_due_at = ${creditsDebitDue ? settledAt.toISOString() : null}::timestamptz,
          updated_at = ${settledAt.toISOString()}::timestamptz
      WHERE id = ${reservation.id}::uuid AND status IN ('active', 'indeterminate', 'expired')
      RETURNING id
    `))[0];
    if (!settled) throw new Error('AI budget reservation changed during settlement');
    return {
      kind: 'settled',
      reservationId: reservation.id,
      actualCostCents: Number(cost),
      invocationIds,
      billingSource: reservation.billing_source,
      creditsDebitDue,
    };
  });
}

/**
 * Ledger rows + rollups derived from them, for a call with no reservation.
 * Same derivation as settlement, in its own system transaction; no
 * organization lock (there is no hold to release).
 */
export async function recordInvocationsWithRollups(input: {
  orgId: string;
  invocations: NewInvocation[];
  sessionId?: string | null;
  messageCount?: number;
  toolExecutionCount?: number;
  turnCount?: number;
  sdkUsage?: SettleSdkUsage;
  now?: Date;
}): Promise<string[]> {
  if (input.invocations.length === 0) return [];
  const at = input.now ?? new Date();
  const keys = periodKeys(at);
  const funding = input.invocations[0]!.fundingSource;
  if (input.invocations.some((row) => row.fundingSource !== funding || row.orgId !== input.orgId)) {
    throw new Error('recordInvocationsWithRollups: rows must share one organization and funding source');
  }
  if (input.invocations.some((row) => row.costCents === null || !Number.isFinite(row.costCents))) {
    throw new Error('recordInvocationsWithRollups: every row must be priced');
  }
  const totals = ledgerTotals(input.invocations);
  const cost = moneyString(totals.actualCostCents, 'actualCostCents');
  return inReservationTransaction('aiBudgetReservations.recordInvocations', async () => {
    const stamped = await stampChargeback(input.orgId, input.invocations); // W10 (#7608): the ledger write
    const ids: string[] = [];
    for (const row of stamped) ids.push(await recordInvocation(row));
    await applyUsageRollups({
      orgId: input.orgId,
      sessionId: input.sessionId ?? null,
      billingSource: funding,
      keys,
      cost,
      inputTokens: nonNegativeInteger(totals.inputTokens, 'inputTokens'),
      outputTokens: nonNegativeInteger(totals.outputTokens, 'outputTokens'),
      messageCount: nonNegativeInteger(input.messageCount ?? 1, 'messageCount'),
      toolExecutionCount: nonNegativeInteger(input.toolExecutionCount ?? 0, 'toolExecutionCount'),
      turnCount: nonNegativeInteger(input.turnCount ?? 1, 'turnCount'),
      at,
    });
    if (input.sdkUsage) await advanceSdkUsageSnapshot(input.orgId, input.sdkUsage);
    return ids;
  });
}

/** The JSON form of a settle input persisted in `pending_settlement`. */
function pendingSettlementJson(input: SettleAiBudgetReservationInput): string {
  return JSON.stringify({ ...input, settledAt: input.settledAt?.toISOString() });
}

function revivePendingSettlement(raw: unknown, row: { id: string; org_id: string }): SettleAiBudgetReservationInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Malformed pending settlement');
  const stored = raw as Record<string, unknown>;
  if (stored.reservationId !== row.id || stored.orgId !== row.org_id) {
    throw new Error('Pending settlement does not belong to its reservation');
  }
  const settledAt = typeof stored.settledAt === 'string' ? new Date(stored.settledAt) : undefined;
  return { ...(stored as unknown as SettleAiBudgetReservationInput), settledAt };
}

/**
 * Review finding 2: persist a settlement the organization lock would not let
 * through, so it cannot be lost. Takes only the RESERVATION row (no org lock),
 * so it does not queue behind the contention that deferred it. Returns
 * 'already_settled' / 'already_pending' when there is nothing to persist.
 */
export async function persistPendingSettlement(
  input: SettleAiBudgetReservationInput,
): Promise<'persisted' | 'already_settled' | 'already_pending'> {
  settlementTotals(input);   // same validation as the settlement it stands for
  return inReservationTransaction('aiBudgetReservations.persistPending', async () => {
    await tightenLockTimeout(db as unknown as { execute(q: unknown): Promise<unknown> }, AI_BUDGET_LOCK_TIMEOUT_MS);
    const persisted = rows<{ id: string }>(await db.execute<{ id: string }>(sql`
      UPDATE ai_budget_reservations SET pending_settlement = ${pendingSettlementJson(input)}::jsonb, updated_at = now()
      WHERE id = ${input.reservationId}::uuid AND org_id = ${input.orgId}::uuid
        AND status IN ('active', 'indeterminate', 'expired') AND pending_settlement IS NULL
      RETURNING id
    `))[0];
    if (persisted) return 'persisted';
    const row = rows<{ status: AiBudgetReservationStatus; pending: boolean }>(await db.execute(sql`
      SELECT status, pending_settlement IS NOT NULL AS pending FROM ai_budget_reservations
      WHERE id = ${input.reservationId}::uuid AND org_id = ${input.orgId}::uuid
    `))[0];
    if (!row) throw new Error('AI budget reservation not found or not visible');
    if (row.status === 'settled') return 'already_settled';
    if (row.pending) return 'already_pending';
    throw new Error(`${row.status} AI budget reservation cannot hold a pending settlement`);
  });
}

export interface ReplayedAiSettlement {
  reservationId: string;
  orgId: string;
  kind: 'settled' | 'already_settled';
  actualCostCents: number;
  creditsDebitDue: boolean;
}

/**
 * Failed replays before a pending settlement is given up on (stamped dead).
 * The sweep runs every 5 minutes, so ~1 hour of consecutive failures; a lock
 * contention that outlasts that is not transient.
 */
export const MAX_PENDING_SETTLEMENT_REPLAY_ATTEMPTS = 12;

/**
 * A replay failed: count it, keep the scrubbed error, and bump updated_at so
 * the row goes to the back of the replay queue (review finding 5 — without the
 * bump, `limit` permanently failing rows were picked first on every run and
 * starved everything behind them). At the cap the row is stamped dead.
 */
async function recordPendingSettlementReplayFailure(
  reservationId: string,
  message: string,
): Promise<{ attempts: number; dead: boolean } | null> {
  return inReservationTransaction('aiBudgetReservations.recordReplayFailure', async () => {
    const row = rows<{ attempts: number; dead: boolean }>(await db.execute(sql`
      UPDATE ai_budget_reservations
      SET pending_settlement_attempts = pending_settlement_attempts + 1,
          pending_settlement_error = ${boundedCode(message)},
          pending_settlement_dead_at = CASE
            WHEN pending_settlement_attempts + 1 >= ${MAX_PENDING_SETTLEMENT_REPLAY_ATTEMPTS} THEN now() ELSE NULL END,
          updated_at = now()
      WHERE id = ${reservationId}::uuid AND pending_settlement IS NOT NULL AND pending_settlement_dead_at IS NULL
      RETURNING pending_settlement_attempts AS attempts, pending_settlement_dead_at IS NOT NULL AS dead
    `))[0];
    return row ? { attempts: Number(row.attempts), dead: row.dead === true } : null;
  });
}

/**
 * Replay every persisted deferred settlement through the same idempotent
 * settleAiBudgetReservation (one transaction each). A row that settles clears
 * its own pending_settlement in that transaction, so a second run finds
 * nothing. A failing row is reported (DB detail scrubbed), counted and moved to
 * the back of the queue; after MAX_PENDING_SETTLEMENT_REPLAY_ATTEMPTS it is
 * stamped dead (Sentry `ai_settlement_replay_dead`, listDeadPendingSettlements)
 * and no longer replayed. It never blocks the others.
 */
export async function replayPendingAiSettlements(limit = 100): Promise<ReplayedAiSettlement[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('limit must be a positive safe integer');
  const pending = await inReservationTransaction('aiBudgetReservations.listPending', async () =>
    rows<{ id: string; org_id: string; pending_settlement: unknown }>(await db.execute(sql`
      SELECT id, org_id, pending_settlement FROM ai_budget_reservations
      WHERE pending_settlement IS NOT NULL AND status <> 'settled' AND pending_settlement_dead_at IS NULL
      ORDER BY updated_at ASC
      LIMIT ${limit}
    `)));
  const out: ReplayedAiSettlement[] = [];
  for (const row of pending) {
    try {
      const result = await settleAiBudgetReservation(revivePendingSettlement(row.pending_settlement, row));
      out.push({
        reservationId: result.reservationId,
        orgId: row.org_id,
        kind: result.kind,
        actualCostCents: result.actualCostCents,
        creditsDebitDue: result.creditsDebitDue,
      });
    } catch (error) {
      const message = safeErrorMessage(error);
      console.error('[AI] pending AI settlement replay failed; left pending for the next sweep', {
        reservationId: row.id, orgId: row.org_id, error: message,
      });
      captureException(new Error(`pending AI settlement replay failed: ${message}`));
      try {
        const recorded = await recordPendingSettlementReplayFailure(row.id, message);
        if (recorded?.dead) {
          console.error('[AI] pending AI settlement replay given up (dead); operator action needed', {
            reservationId: row.id, orgId: row.org_id, attempts: recorded.attempts, error: message,
          });
          captureMessage('Pending AI settlement replay exhausted its attempts; spend is unrecorded until an operator acts', {
            eventCode: 'ai_settlement_replay_dead',
            level: 'error',
          });
        }
      } catch (recordError) {
        const recordMessage = safeErrorMessage(recordError);
        console.error('[AI] could not record the pending settlement replay failure', {
          reservationId: row.id, orgId: row.org_id, error: recordMessage,
        });
        captureException(new Error(`pending AI settlement replay failure not recorded: ${recordMessage}`));
      }
    }
  }
  return out;
}

export interface DeadPendingSettlement {
  reservationId: string;
  orgId: string;
  status: AiBudgetReservationStatus;
  attempts: number;
  error: string | null;
  deadAt: string;
}

/** Operator view: deferred settlements the replay gave up on (finding 5), newest first. */
export async function listDeadPendingSettlements(limit = 100): Promise<DeadPendingSettlement[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('limit must be a positive safe integer');
  return inReservationTransaction('aiBudgetReservations.listDeadPending', async () =>
    rows<{ id: string; org_id: string; status: AiBudgetReservationStatus; attempts: number; error: string | null; dead_at: string }>(
      await db.execute(sql`
        SELECT id, org_id, status, pending_settlement_attempts AS attempts, pending_settlement_error AS error,
               pending_settlement_dead_at::text AS dead_at
        FROM ai_budget_reservations
        WHERE pending_settlement_dead_at IS NOT NULL AND pending_settlement IS NOT NULL
        ORDER BY pending_settlement_dead_at DESC
        LIMIT ${limit}
      `),
    ).map((row) => ({
      reservationId: row.id,
      orgId: row.org_id,
      status: row.status,
      attempts: Number(row.attempts),
      error: row.error,
      deadAt: row.dead_at,
    })));
}

/**
 * Settle, but never lose the spend to lock contention.
 *
 * Settlement runs AFTER the provider has been paid, so the three callers in
 * `aiCostTracker` cannot simply propagate a failure: an unhandled
 * {@link AiBudgetLockTimeoutError} there drops the usage from `ai_cost_usage`
 * AND leaves the reservation `active`, holding the organization's entire cap
 * until the active TTL closes it. That is the B3 failure re-entered through B2.
 *
 * So: wait longer than admission does, retry once (contention on one org row is
 * short-lived by construction — every holder is itself a bounded reservation
 * transaction), and if it still will not settle, PERSIST the settle input on
 * the reservation (W03 review finding 2: `pending_settlement`, replayed by the
 * sweep) and mark the reservation `indeterminate` so the 24 h window applies.
 * `persisted` says whether the spend is safe; when it is false the old
 * capture-and-log path is all there is.
 *
 * A non-lock error is rethrown unchanged — only contention is retryable, and
 * retrying (say) a conflicting-settlement error would just raise it twice.
 */
export async function settleAiBudgetReservationDurably(
  input: SettleAiBudgetReservationInput,
): Promise<SettleAiBudgetReservationResult | DeferredAiBudgetSettlement> {
  try {
    return await settleAiBudgetReservation(input);
  } catch (firstError) {
    if (!isAiBudgetLockTimeout(firstError)) throw firstError;
    try {
      return await settleAiBudgetReservation(input);
    } catch (retryError) {
      if (!isAiBudgetLockTimeout(retryError)) throw retryError;
      const totals = settlementTotals(input);
      console.error('[AI] budget settlement blocked twice on the organization lock', {
        orgId: input.orgId,
        reservationId: input.reservationId,
        actualCostCents: totals.actualCostCents,
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
      });
      captureException(retryError instanceof Error ? retryError : new Error(String(retryError)));
      let persisted = false;
      try {
        const outcome = await persistPendingSettlement(input);
        // 'already_settled': another call settled it between our attempts, so
        // nothing is lost and that call owns the debit.
        persisted = outcome !== 'already_pending';
        if (outcome === 'already_pending') {
          console.warn('[AI] a pending settlement already exists for this reservation; this one was not persisted', {
            orgId: input.orgId, reservationId: input.reservationId,
          });
          persisted = false;
        }
      } catch (persistError) {
        const message = safeErrorMessage(persistError);
        console.error('[AI] deferred AI settlement could not be persisted; spend is unrecorded', {
          orgId: input.orgId, reservationId: input.reservationId, error: message,
        });
        captureException(new Error(`deferred AI settlement could not be persisted: ${message}`));
      }
      // Best effort, and bounded either way: if THIS also cannot take the lock
      // the row stays `active` and the 30-minute active TTL still reclaims the
      // cap — the tenant is never locked out indefinitely; a persisted
      // settlement is still replayed (expired rows are settleable).
      await markAiBudgetReservationIndeterminate({
        orgId: input.orgId,
        reservationId: input.reservationId,
      }).catch((markError) => {
        console.error('[AI] budget reservation could not be marked indeterminate', safeErrorMessage(markError));
        captureException(markError instanceof Error ? markError : new Error(String(markError)));
      });
      return { kind: 'deferred_indeterminate', reservationId: input.reservationId, persisted };
    }
  }
}

export async function markAiBudgetReservationIndeterminate(input: {
  orgId: string;
  reservationId: string;
  markedAt?: Date;
}): Promise<{
  kind: 'indeterminate' | 'already_indeterminate' | 'already_settled' | 'already_expired';
  reservationId: string;
}> {
  const markedAt = input.markedAt ?? new Date();
  // Database clock, for the same reason as admission above.
  const indeterminateTtlSeconds = AI_BUDGET_RESERVATION_INDETERMINATE_TTL_MS / 1000;
  return inReservationTransaction('aiBudgetReservations.indeterminate', async () => {
    await lockOrganizationRow(input.orgId, 'indeterminate marking', AI_BUDGET_SETTLEMENT_LOCK_TIMEOUT_MS);
    const reservation = rows<ReservationRow>(await db.execute<ReservationRow>(sql`
      SELECT id, org_id, idempotency_key, session_id, billing_source, namespace,
             daily_period_key, monthly_period_key, uncapped,
             reserved_cost_cents, actual_cost_cents, status, settlement_fingerprint,
             expires_at
      FROM ai_budget_reservations
      WHERE id = ${input.reservationId}::uuid AND org_id = ${input.orgId}::uuid
      FOR UPDATE
    `))[0];
    if (!reservation) throw new Error('AI budget reservation not found or not visible');
    if (reservation.status === 'settled') return { kind: 'already_settled', reservationId: reservation.id };
    if (reservation.status === 'indeterminate') return { kind: 'already_indeterminate', reservationId: reservation.id };
    // Already swept: the window closed while the provider was still out. The
    // row no longer holds capacity and must not silently reclaim it, so this is
    // reported, not re-extended. A late completion can still settle it.
    if (reservation.status === 'expired') return { kind: 'already_expired', reservationId: reservation.id };
    if (reservation.status === 'released') throw new Error('Released AI budget reservation cannot become indeterminate');
    // The claim is extended to the much longer indeterminate window: the
    // outcome is unknown, so the reservation keeps consuming capacity — but for
    // a bounded time, not forever (B3).
    await db.execute(sql`
      UPDATE ai_budget_reservations
      SET status = 'indeterminate', indeterminate_at = ${markedAt.toISOString()}::timestamptz,
          expires_at = now() + make_interval(secs => ${indeterminateTtlSeconds}),
          updated_at = ${markedAt.toISOString()}::timestamptz
      WHERE id = ${reservation.id}::uuid
    `);
    return { kind: 'indeterminate', reservationId: reservation.id };
  });
}

/** Release only an active reservation whose provider dispatch provably failed before send. */
export async function releaseUnusedAiBudgetReservation(input: {
  orgId: string;
  reservationId: string;
  releasedAt?: Date;
}): Promise<{ kind: 'released' | 'already_released' | 'already_expired'; reservationId: string }> {
  const releasedAt = input.releasedAt ?? new Date();
  return inReservationTransaction('aiBudgetReservations.releaseUnused', async () => {
    await lockOrganizationRow(input.orgId, 'release', AI_BUDGET_SETTLEMENT_LOCK_TIMEOUT_MS);
    const reservation = rows<ReservationRow>(await db.execute<ReservationRow>(sql`
      SELECT id, org_id, idempotency_key, session_id, billing_source, namespace,
             daily_period_key, monthly_period_key, uncapped,
             reserved_cost_cents, actual_cost_cents, status, settlement_fingerprint,
             expires_at
      FROM ai_budget_reservations
      WHERE id = ${input.reservationId}::uuid AND org_id = ${input.orgId}::uuid
      FOR UPDATE
    `))[0];
    if (!reservation) throw new Error('AI budget reservation not found or not visible');
    if (reservation.status === 'released') return { kind: 'already_released', reservationId: reservation.id };
    // Swept already: capacity is back with the org, which is what the caller
    // wanted. Nothing to do, and nothing to raise about.
    if (reservation.status === 'expired') return { kind: 'already_expired', reservationId: reservation.id };
    if (reservation.status !== 'active') {
      throw new Error(`${reservation.status} AI budget reservation cannot be released`);
    }
    await db.execute(sql`
      UPDATE ai_budget_reservations
      SET status = 'released', released_at = ${releasedAt.toISOString()}::timestamptz,
          updated_at = ${releasedAt.toISOString()}::timestamptz
      WHERE id = ${reservation.id}::uuid
    `);
    return { kind: 'released', reservationId: reservation.id };
  });
}

export type AiBudgetReservationExpiryReason = 'active_ttl' | 'indeterminate_ttl';

export interface ExpiredAiBudgetReservation {
  reservationId: string;
  orgId: string;
  reason: AiBudgetReservationExpiryReason;
  reservedCostCents: number;
}

/**
 * Release reservations whose window has closed (B3b).
 *
 * A reservation holds the organization's ENTIRE remaining cap, so an
 * unsettled one is a denial of the tenant's own budget. Admission already
 * ignores rows past `expires_at`, which is what keeps the ledger CORRECT; this
 * sweep is what makes it OBSERVABLE and keeps the table's status column honest
 * — an operator reading `status` should not have to re-derive expiry from a
 * timestamp, and every reclaimed cap should leave a trace.
 *
 * THE STATUS PREDICATE IS REPEATED ON THE OUTER `WHERE`, AND THAT IS LOAD-BEARING.
 * Under READ COMMITTED, an UPDATE that blocks on a row locked by a concurrent
 * transaction re-evaluates its own qual against the NEW row version when that
 * transaction commits (EvalPlanQual). A qual of the form `id IN (subselect)`
 * re-checks only the id — the subselect ran on the ORIGINAL snapshot and is not
 * re-executed — so a row that `settleAiBudgetReservation` just moved to
 * `settled` (while holding `FOR UPDATE`) would still match and be relabelled
 * `expired`. That is not merely untidy: a settlement retry would then miss the
 * `status === 'settled'` fingerprint guard, re-run the `ai_cost_usage` upserts
 * and DOUBLE CHARGE the tenant. With the predicate on the outer WHERE too,
 * EvalPlanQual re-checks the status on the new version and the row is skipped.
 *
 * No row locks are taken beyond the UPDATE's own: a concurrent settle racing it
 * is then fine in both orders — settling an `expired` row is explicitly allowed,
 * and expiring an already-`settled` row cannot match.
 */
export async function expireStaleAiBudgetReservations(
  limit = 500,
): Promise<ExpiredAiBudgetReservation[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('limit must be a positive safe integer');
  }
  const swept = rows<{
    id: string;
    org_id: string;
    expiry_reason: AiBudgetReservationExpiryReason;
    reserved_cost_cents: string | number;
  }>(await db.execute(sql`
    UPDATE ai_budget_reservations
    SET status = 'expired',
        expired_at = now(),
        updated_at = now(),
        -- SET reads the OLD row, so this names the status the row is leaving.
        expiry_reason = CASE WHEN status = 'active' THEN 'active_ttl' ELSE 'indeterminate_ttl' END
    WHERE status IN ('active', 'indeterminate')
      AND expires_at <= now()
      AND id IN (
        SELECT id FROM ai_budget_reservations
        WHERE status IN ('active', 'indeterminate') AND expires_at <= now()
        ORDER BY expires_at ASC
        LIMIT ${limit}
      )
    RETURNING id, org_id, expiry_reason, reserved_cost_cents
  `));
  return swept.map((row) => ({
    reservationId: row.id,
    orgId: row.org_id,
    reason: row.expiry_reason,
    reservedCostCents: Number(row.reserved_cost_cents),
  }));
}

// ---------------------------------------------------------------------------
// Exactly-once platform credit debit (W03 #7601 Step 8a, review finding 1)
//
// The debit is keyed `ai-settlement:<reservation id>` and the billing service
// dedupes it, so a retry after a lost response cannot double-charge. These
// helpers keep the durable side: due (set by the ledger settlement) → debited,
// or → failed (terminal: a 4xx, or MAX_CREDIT_DEBIT_ATTEMPTS retryable
// failures). A failed row is excluded from the sweep's retry and listed for an
// operator (`listFailedCreditDebits`); `clearCreditDebitFailure` re-queues one
// after the cause is fixed. All self-contexted (own short system transaction),
// so no caller holds a pooled connection across the billing HTTP call.
// ---------------------------------------------------------------------------

/**
 * Retryable (5xx / 408 / 429 / transport) attempts before a debit is stamped
 * failed. The settle-time attempt is the first; the sweep (every 5 min) makes
 * the rest, so 24 attempts give the billing service about two hours.
 */
export const MAX_CREDIT_DEBIT_ATTEMPTS = 24;
/** Grace before the sweep retries a debit the settling call is still making. */
export const CREDIT_DEBIT_SWEEP_GRACE_SECONDS = 120;

export function creditDebitIdempotencyKey(reservationId: string): string {
  return `ai-settlement:${reservationId}`;
}

function boundedCode(code: string): string {
  return code.slice(0, 128);
}

/** The billing service confirmed the keyed debit. Idempotent. */
export async function markCreditsDebited(reservationId: string): Promise<void> {
  await inReservationTransaction('aiBudgetReservations.markCreditsDebited', async () => {
    await db.execute(sql`
      UPDATE ai_budget_reservations
      SET credits_debited_at = now(), credits_debit_failed_at = NULL, credits_debit_error = NULL, updated_at = now()
      WHERE id = ${reservationId}::uuid AND credits_debited_at IS NULL
      RETURNING id
    `);
  });
}

/** Terminal: the billing service refused the debit (4xx). Never retried by the sweep. */
export async function recordCreditDebitFailure(reservationId: string, code: string): Promise<void> {
  await inReservationTransaction('aiBudgetReservations.recordCreditDebitFailure', async () => {
    await db.execute(sql`
      UPDATE ai_budget_reservations
      SET credits_debit_failed_at = now(), credits_debit_error = ${boundedCode(code)},
          credits_debit_attempts = credits_debit_attempts + 1, updated_at = now()
      WHERE id = ${reservationId}::uuid AND credits_debited_at IS NULL AND credits_debit_failed_at IS NULL
      RETURNING id
    `);
  });
}

/**
 * A retryable failure: count it, and stamp the row failed
 * (`retries_exhausted:<code>`) once MAX_CREDIT_DEBIT_ATTEMPTS is reached.
 */
export async function recordCreditDebitRetry(reservationId: string, code: string): Promise<{ attempts: number; exhausted: boolean }> {
  return inReservationTransaction('aiBudgetReservations.recordCreditDebitRetry', async () => {
    const row = rows<{ attempts: number; exhausted: boolean }>(await db.execute(sql`
      UPDATE ai_budget_reservations
      SET credits_debit_attempts = credits_debit_attempts + 1,
          credits_debit_error = CASE WHEN credits_debit_attempts + 1 >= ${MAX_CREDIT_DEBIT_ATTEMPTS}
            THEN ${boundedCode(`retries_exhausted:${code}`)} ELSE ${boundedCode(code)} END,
          credits_debit_failed_at = CASE WHEN credits_debit_attempts + 1 >= ${MAX_CREDIT_DEBIT_ATTEMPTS}
            THEN now() ELSE NULL END,
          updated_at = now()
      WHERE id = ${reservationId}::uuid AND credits_debited_at IS NULL AND credits_debit_failed_at IS NULL
      RETURNING credits_debit_attempts AS attempts, credits_debit_failed_at IS NOT NULL AS exhausted
    `))[0];
    return row ? { attempts: Number(row.attempts), exhausted: row.exhausted === true } : { attempts: 0, exhausted: false };
  });
}

export interface UndebitedPlatformSettlement {
  reservationId: string;
  orgId: string;
  /** The settled amount, exactly as first sent (the billing service 409s a key reused with another amount). */
  costCents: number;
  attempts: number;
}

/**
 * Ledger-settled platform spend whose keyed debit is not yet confirmed: due,
 * not debited, not failed, and older than the settling call's own grace.
 * Failed rows are EXCLUDED so a terminal refusal never loops.
 */
export async function listUndebitedPlatformSettlements(limit = 100): Promise<UndebitedPlatformSettlement[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('limit must be a positive safe integer');
  return inReservationTransaction('aiBudgetReservations.listUndebited', async () =>
    rows<{ id: string; org_id: string; actual_cost_cents: string | number; credits_debit_attempts: number }>(await db.execute(sql`
      SELECT id, org_id, actual_cost_cents, credits_debit_attempts FROM ai_budget_reservations
      WHERE credits_debit_due_at IS NOT NULL
        AND credits_debited_at IS NULL
        AND credits_debit_failed_at IS NULL
        AND status = 'settled'
        AND billing_source = 'platform'
        AND actual_cost_cents > 0
        AND credits_debit_due_at < now() - make_interval(secs => ${CREDIT_DEBIT_SWEEP_GRACE_SECONDS})
      ORDER BY credits_debit_due_at ASC
      LIMIT ${limit}
    `)).map((row) => ({
      reservationId: row.id,
      orgId: row.org_id,
      costCents: Number(row.actual_cost_cents),
      attempts: Number(row.credits_debit_attempts),
    })));
}

export interface FailedCreditDebit {
  reservationId: string;
  orgId: string;
  costCents: number;
  error: string | null;
  attempts: number;
  failedAt: string;
  settledAt: string | null;
}

/** Operator view: platform spend whose credit debit failed terminally, newest first. */
export async function listFailedCreditDebits(limit = 100): Promise<FailedCreditDebit[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('limit must be a positive safe integer');
  return inReservationTransaction('aiBudgetReservations.listFailedDebits', async () =>
    rows<{
      id: string; org_id: string; actual_cost_cents: string | number; credits_debit_error: string | null;
      credits_debit_attempts: number; failed_at: string; settled_at: string | null;
    }>(await db.execute(sql`
      SELECT id, org_id, actual_cost_cents, credits_debit_error, credits_debit_attempts,
             credits_debit_failed_at::text AS failed_at, settled_at::text AS settled_at
      FROM ai_budget_reservations
      WHERE credits_debit_failed_at IS NOT NULL AND credits_debited_at IS NULL
      ORDER BY credits_debit_failed_at DESC
      LIMIT ${limit}
    `)).map((row) => ({
      reservationId: row.id,
      orgId: row.org_id,
      costCents: Number(row.actual_cost_cents),
      error: row.credits_debit_error,
      attempts: Number(row.credits_debit_attempts),
      failedAt: row.failed_at,
      settledAt: row.settled_at,
    })));
}

/**
 * Operator re-drive: clear a failed debit so the sweep retries it under the
 * SAME key (safe — the billing service dedupes). Use after fixing the cause
 * (e.g. a rotated billing key). Returns false when there was nothing to clear.
 */
export async function clearCreditDebitFailure(reservationId: string): Promise<boolean> {
  return inReservationTransaction('aiBudgetReservations.clearCreditDebitFailure', async () =>
    rows<{ id: string }>(await db.execute(sql`
      UPDATE ai_budget_reservations
      SET credits_debit_failed_at = NULL, credits_debit_error = NULL, credits_debit_attempts = 0, updated_at = now()
      WHERE id = ${reservationId}::uuid AND credits_debit_failed_at IS NOT NULL AND credits_debited_at IS NULL
      RETURNING id
    `)).length > 0);
}
