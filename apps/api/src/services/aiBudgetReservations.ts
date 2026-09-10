import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  db,
  getCurrentDbAccessContext,
  runOutsideDbContext,
  withDbAccessContext,
  withSystemDbAccessContext,
} from '../db';
import { getEffectiveAiBudget } from './effectiveSettings';
import type { AiBillingSource } from './aiCostTracker';

export type { AiBillingSource } from './aiCostTracker';

export type AiBudgetReservationStatus = 'active' | 'settled' | 'indeterminate' | 'released';
export type AiBudgetDenialReason = 'ai_disabled' | 'daily_budget' | 'monthly_budget';

export interface ReserveAiBudgetInput {
  orgId: string;
  idempotencyKey: string;
  billingSource: AiBillingSource;
  sessionId?: string | null;
  now?: Date;
}

type ReservationIdentity = {
  reservationId: string;
  dailyPeriodKey: string;
  monthlyPeriodKey: string;
  status: 'active' | 'indeterminate';
};

export type ReserveAiBudgetResult =
  | ({ kind: 'unlimited' } & ReservationIdentity)
  | ({ kind: 'reserved'; reservedCostCents: number } & ReservationIdentity)
  | { kind: 'denied'; reason: AiBudgetDenialReason; message: string };

export interface SettleAiBudgetReservationInput {
  orgId: string;
  reservationId: string;
  actualCostCents: number;
  inputTokens: number;
  outputTokens: number;
  messageCount?: number;
  toolExecutionCount?: number;
  session?: { id: string; turnCount?: number };
  settledAt?: Date;
}

export type SettleAiBudgetReservationResult = {
  kind: 'settled' | 'already_settled';
  reservationId: string;
  actualCostCents: number;
};

type ReservationRow = Record<string, unknown> & {
  id: string;
  org_id: string;
  idempotency_key: string;
  session_id: string | null;
  billing_source: AiBillingSource;
  daily_period_key: string;
  monthly_period_key: string;
  uncapped: boolean;
  reserved_cost_cents: string | number;
  actual_cost_cents: string | number | null;
  status: AiBudgetReservationStatus;
  settlement_fingerprint: string | null;
};

type UsageAndReservationsRow = Record<string, unknown> & {
  daily_usage: string | number;
  monthly_usage: string | number;
  daily_reserved: string | number;
  monthly_reserved: string | number;
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
}

/**
 * Give the reservation its own short transaction even when called from a
 * request-wide DB context. The org lock must commit before provider dispatch;
 * retaining it across a network request would serialize spend but make the
 * transaction itself the availability bottleneck.
 */
function inShortAccessContext<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const ambient = getCurrentDbAccessContext();
  return runOutsideDbContext(() => ambient
    ? withDbAccessContext(ambient, fn)
    : withSystemDbAccessContext(fn, label));
}

function denial(reason: AiBudgetDenialReason, capCents?: number): ReserveAiBudgetResult {
  if (reason === 'ai_disabled') {
    return { kind: 'denied', reason, message: 'AI features are disabled for this organization' };
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

  return inShortAccessContext('aiBudgetReservations.reserve', async () => {
    const org = rows<{ id: string }>(await db.execute<{ id: string }>(sql`
      SELECT id FROM organizations WHERE id = ${input.orgId}::uuid FOR UPDATE
    `))[0];
    if (!org) throw new Error('Organization not found or not visible');

    const existing = rows<ReservationRow>(await db.execute<ReservationRow>(sql`
      SELECT id, org_id, idempotency_key, session_id, billing_source,
             daily_period_key, monthly_period_key, uncapped,
             reserved_cost_cents, actual_cost_cents, status, settlement_fingerprint
      FROM ai_budget_reservations
      WHERE org_id = ${input.orgId}::uuid AND idempotency_key = ${input.idempotencyKey}
      FOR UPDATE
    `))[0];
    if (existing) {
      if (existing.billing_source !== input.billingSource || existing.session_id !== sessionId) {
        throw new Error('AI budget reservation idempotency key conflicts with another dispatch');
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

    const uncapped = budget.dailyBudgetCents === null && budget.monthlyBudgetCents === null;
    let reservedCostCents = 0;
    if (!uncapped) {
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
                      AND status IN ('active', 'indeterminate')), 0)::text AS daily_reserved,
          COALESCE((SELECT sum(reserved_cost_cents) FROM ai_budget_reservations
                    WHERE org_id = ${input.orgId}::uuid
                      AND monthly_period_key = ${keys.monthly}
                      AND status IN ('active', 'indeterminate')), 0)::text AS monthly_reserved
      `))[0];
      if (!usage) throw new Error('Failed to read AI budget usage');

      // Existing aggregate rows predate this fence. Treat any malformed
      // negative legacy total as zero; it must never manufacture capacity.
      const dailySpent = Math.max(0, Number(usage.daily_usage))
        + Math.max(0, Number(usage.daily_reserved));
      const monthlySpent = Math.max(0, Number(usage.monthly_usage))
        + Math.max(0, Number(usage.monthly_reserved));
      const dailyRemaining = budget.dailyBudgetCents === null
        ? Number.POSITIVE_INFINITY
        : budget.dailyBudgetCents - dailySpent;
      const monthlyRemaining = budget.monthlyBudgetCents === null
        ? Number.POSITIVE_INFINITY
        : budget.monthlyBudgetCents - monthlySpent;
      if (dailyRemaining <= 0) return denial('daily_budget', budget.dailyBudgetCents ?? 0);
      if (monthlyRemaining <= 0) return denial('monthly_budget', budget.monthlyBudgetCents ?? 0);
      reservedCostCents = Math.min(dailyRemaining, monthlyRemaining);
    }

    const inserted = rows<ReservationRow>(await db.execute<ReservationRow>(sql`
      INSERT INTO ai_budget_reservations (
        org_id, idempotency_key, session_id, billing_source,
        daily_period_key, monthly_period_key, uncapped, reserved_cost_cents
      ) VALUES (
        ${input.orgId}::uuid, ${input.idempotencyKey}, ${sessionId}::uuid, ${input.billingSource},
        ${keys.daily}, ${keys.monthly}, ${uncapped},
        ${moneyString(reservedCostCents, 'reservedCostCents')}::numeric
      )
      RETURNING id, org_id, idempotency_key, session_id, billing_source,
                daily_period_key, monthly_period_key, uncapped,
                reserved_cost_cents, actual_cost_cents, status, settlement_fingerprint
    `))[0];
    if (!inserted) throw new Error('Failed to create AI budget reservation');
    return existingResult(inserted);
  });
}

function settlementFingerprint(input: SettleAiBudgetReservationInput, normalizedCost: string): string {
  const canonical = JSON.stringify({
    actualCostCents: normalizedCost,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    messageCount: input.messageCount ?? 1,
    toolExecutionCount: input.toolExecutionCount ?? 0,
    sessionId: input.session?.id ?? null,
    sessionTurnCount: input.session?.turnCount ?? 1,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** Settle actual usage and every durable aggregate in one transaction. */
export async function settleAiBudgetReservation(
  input: SettleAiBudgetReservationInput,
): Promise<SettleAiBudgetReservationResult> {
  const cost = moneyString(input.actualCostCents, 'actualCostCents');
  const inputTokens = nonNegativeInteger(input.inputTokens, 'inputTokens');
  const outputTokens = nonNegativeInteger(input.outputTokens, 'outputTokens');
  const messageCount = nonNegativeInteger(input.messageCount ?? 1, 'messageCount');
  const toolExecutionCount = nonNegativeInteger(input.toolExecutionCount ?? 0, 'toolExecutionCount');
  const turnCount = nonNegativeInteger(input.session?.turnCount ?? 1, 'session.turnCount');
  const settledAt = input.settledAt ?? new Date();
  if (!Number.isFinite(settledAt.getTime())) throw new Error('settledAt must be valid');
  const fingerprint = settlementFingerprint(input, cost);

  return inShortAccessContext('aiBudgetReservations.settle', async () => {
    const org = rows<{ id: string }>(await db.execute<{ id: string }>(sql`
      SELECT id FROM organizations WHERE id = ${input.orgId}::uuid FOR UPDATE
    `))[0];
    if (!org) throw new Error('Organization not found or not visible');

    const reservation = rows<ReservationRow>(await db.execute<ReservationRow>(sql`
      SELECT id, org_id, idempotency_key, session_id, billing_source,
             daily_period_key, monthly_period_key, uncapped,
             reserved_cost_cents, actual_cost_cents, status, settlement_fingerprint
      FROM ai_budget_reservations
      WHERE id = ${input.reservationId}::uuid AND org_id = ${input.orgId}::uuid
      FOR UPDATE
    `))[0];
    if (!reservation) throw new Error('AI budget reservation not found or not visible');
    if (reservation.status === 'settled') {
      if (reservation.settlement_fingerprint !== fingerprint) {
        throw new Error('Conflicting settlement for AI budget reservation');
      }
      return { kind: 'already_settled', reservationId: reservation.id, actualCostCents: Number(reservation.actual_cost_cents) };
    }
    if (reservation.status === 'released') {
      throw new Error('Released AI budget reservation cannot be settled');
    }
    if (input.session && reservation.session_id !== input.session.id) {
      throw new Error('Settlement session does not match AI budget reservation');
    }
    if (!reservation.session_id && input.session) {
      throw new Error('Sessionless AI budget reservation cannot update a session');
    }
    if (reservation.session_id && !input.session) {
      throw new Error('Session-bound AI budget reservation requires session settlement');
    }

    if (input.session) {
      const updatedSession = rows<{ id: string }>(await db.execute<{ id: string }>(sql`
        UPDATE ai_sessions
        SET total_input_tokens = total_input_tokens + ${inputTokens},
            total_output_tokens = total_output_tokens + ${outputTokens},
            total_cost_cents = total_cost_cents + ${cost}::numeric,
            billing_source = ${reservation.billing_source},
            turn_count = turn_count + ${turnCount},
            last_activity_at = ${settledAt.toISOString()}::timestamptz,
            updated_at = ${settledAt.toISOString()}::timestamptz
        WHERE id = ${input.session.id}::uuid AND org_id = ${input.orgId}::uuid
        RETURNING id
      `))[0];
      if (!updatedSession) throw new Error('AI session not found in settlement organization');
    }

    for (const [period, key] of [
      ['daily', reservation.daily_period_key],
      ['monthly', reservation.monthly_period_key],
    ] as const) {
      await db.execute(sql`
        INSERT INTO ai_cost_usage (
          org_id, period, period_key, input_tokens, output_tokens,
          total_cost_cents, session_count, message_count, tool_execution_count,
          billing_source, updated_at
        ) VALUES (
          ${input.orgId}::uuid, ${period}, ${key}, ${inputTokens}, ${outputTokens},
          ${cost}::numeric, 0, ${messageCount}, ${toolExecutionCount},
          ${reservation.billing_source}, ${settledAt.toISOString()}::timestamptz
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

    const settled = rows<{ id: string }>(await db.execute<{ id: string }>(sql`
      UPDATE ai_budget_reservations
      SET status = 'settled', actual_cost_cents = ${cost}::numeric,
          settlement_fingerprint = ${fingerprint},
          settled_at = ${settledAt.toISOString()}::timestamptz,
          updated_at = ${settledAt.toISOString()}::timestamptz
      WHERE id = ${reservation.id}::uuid AND status IN ('active', 'indeterminate')
      RETURNING id
    `))[0];
    if (!settled) throw new Error('AI budget reservation changed during settlement');
    return { kind: 'settled', reservationId: reservation.id, actualCostCents: Number(cost) };
  });
}

export async function markAiBudgetReservationIndeterminate(input: {
  orgId: string;
  reservationId: string;
  markedAt?: Date;
}): Promise<{ kind: 'indeterminate' | 'already_indeterminate' | 'already_settled'; reservationId: string }> {
  const markedAt = input.markedAt ?? new Date();
  return inShortAccessContext('aiBudgetReservations.indeterminate', async () => {
    const org = rows<{ id: string }>(await db.execute<{ id: string }>(sql`
      SELECT id FROM organizations WHERE id = ${input.orgId}::uuid FOR UPDATE
    `))[0];
    if (!org) throw new Error('Organization not found or not visible');
    const reservation = rows<ReservationRow>(await db.execute<ReservationRow>(sql`
      SELECT id, org_id, idempotency_key, session_id, billing_source,
             daily_period_key, monthly_period_key, uncapped,
             reserved_cost_cents, actual_cost_cents, status, settlement_fingerprint
      FROM ai_budget_reservations
      WHERE id = ${input.reservationId}::uuid AND org_id = ${input.orgId}::uuid
      FOR UPDATE
    `))[0];
    if (!reservation) throw new Error('AI budget reservation not found or not visible');
    if (reservation.status === 'settled') return { kind: 'already_settled', reservationId: reservation.id };
    if (reservation.status === 'indeterminate') return { kind: 'already_indeterminate', reservationId: reservation.id };
    if (reservation.status === 'released') throw new Error('Released AI budget reservation cannot become indeterminate');
    await db.execute(sql`
      UPDATE ai_budget_reservations
      SET status = 'indeterminate', indeterminate_at = ${markedAt.toISOString()}::timestamptz,
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
}): Promise<{ kind: 'released' | 'already_released'; reservationId: string }> {
  const releasedAt = input.releasedAt ?? new Date();
  return inShortAccessContext('aiBudgetReservations.releaseUnused', async () => {
    const org = rows<{ id: string }>(await db.execute<{ id: string }>(sql`
      SELECT id FROM organizations WHERE id = ${input.orgId}::uuid FOR UPDATE
    `))[0];
    if (!org) throw new Error('Organization not found or not visible');
    const reservation = rows<ReservationRow>(await db.execute<ReservationRow>(sql`
      SELECT id, org_id, idempotency_key, session_id, billing_source,
             daily_period_key, monthly_period_key, uncapped,
             reserved_cost_cents, actual_cost_cents, status, settlement_fingerprint
      FROM ai_budget_reservations
      WHERE id = ${input.reservationId}::uuid AND org_id = ${input.orgId}::uuid
      FOR UPDATE
    `))[0];
    if (!reservation) throw new Error('AI budget reservation not found or not visible');
    if (reservation.status === 'released') return { kind: 'already_released', reservationId: reservation.id };
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
