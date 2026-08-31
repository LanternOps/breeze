import { and, count, eq, gt, sql } from 'drizzle-orm';
import { db } from '../../db';
import { aiUnattendedExposure } from '../../db/schema/aiUnattendedExposure';
import { countContractDevices } from '../contractQuantities';

/**
 * Wave 6 PR 1 (#3828) — the pure, read-only twin of the two SELECT queries
 * `policyDecide.ts`'s `runAuthorizeTransaction` uses to gate a policy
 * decision. Extracted verbatim (same tables, same conditions, same order —
 * only the mutating advisory-lock/insert/CAS/outbox steps stay in
 * `policyDecide.ts`) so BOTH callers share one implementation of the
 * enforcement math instead of two copies that can drift:
 *
 *  - `policyDecide.ts` calls this from INSIDE its own system-scoped
 *    transaction (`inSystemDbContext`/`withSystemDbAccessContext`) — since
 *    `db` here is the same ambient, AsyncLocalStorage-backed accessor used
 *    everywhere else in this codebase (see `withDbAccessContext` /
 *    `withSystemDbAccessContext` in `db/index.ts`), calling this function
 *    from inside that transaction reuses the SAME live transaction — no
 *    explicit tx handle needs to be threaded through. Behavior is byte
 *    identical to the inline queries it replaces.
 *  - `GET /ai/agents/exposure-budget` (routes/aiAgents.ts) calls this
 *    read-only, under the caller's own request-scoped (RLS-enforced)
 *    context, with no `deviceId` — see that param's docstring below.
 *
 * DO NOT add a write here. The moment this needs to mutate anything, it has
 * stopped being safe to call from a plain read route.
 */
export interface ExposureBudgetParams {
  orgId: string;
  /** Scopes `policyDecisionsToday` — mirrors `runAuthorizeTransaction`'s own
   *  per-(org, agent, source='policy_intent') day-cap query. */
  agentId: string;
  maxFleetPercentPerDay: number;
  maxPolicyDecisionsPerDay: number;
  /**
   * The device a live policy decision is being evaluated FOR. When given,
   * `distinctDevices` is the PROJECTED count `runAuthorizeTransaction` checks
   * against the allowance — the currently-exposed set plus this device, if
   * it is not already in it. Omit it (as the read-only budget route does) to
   * get the count of devices ALREADY recorded in the window, with no
   * hypothetical device added — there is no live decision to project.
   */
  deviceId?: string;
  /**
   * When true, skip the second (day-cap) query entirely once the fleet-cap
   * check already failed — matches `runAuthorizeTransaction`'s ORIGINAL
   * inline control flow exactly (it returns `fleet_cap_exceeded` before ever
   * running the day-count query), which `policyDecide.test.ts` asserts on
   * directly (no `ai_unattended_exposure` day-count row queued for that
   * case). The read-only budget route leaves this `false` (the default) —
   * it always wants both figures for display, regardless of whether either
   * cap is already exceeded.
   */
  shortCircuitOnFleetCapExceeded?: boolean;
}

export interface ExposureBudgetResult {
  /** Distinct devices with a recorded exposure row in the trailing 24h
   *  window, optionally including the projected candidate — see
   *  `ExposureBudgetParams.deviceId`. */
  distinctDevices: number;
  /** floor(contractDeviceCount * maxFleetPercentPerDay / 100). No
   *  `max(1, ·)` — a fleet too small for a whole device's worth of allowance
   *  gets zero unattended authorizations (locked quorum decision, see
   *  `policyDecide.ts`). */
  allowance: number;
  contractDeviceCount: number;
  maxFleetPercentPerDay: number;
  /** Count of this agent's `source: 'policy_intent'` exposure rows recorded
   *  in the trailing 24h window. `null` ONLY when `shortCircuitOnFleetCapExceeded`
   *  skipped the query because the fleet cap already failed — the read-only
   *  budget route never sees `null` here, since it never short-circuits. */
  policyDecisionsToday: number | null;
  maxPolicyDecisionsPerDay: number;
  windowHours: 24;
}

export async function computeExposureBudget(params: ExposureBudgetParams): Promise<ExposureBudgetResult> {
  const {
    orgId, agentId, maxFleetPercentPerDay, maxPolicyDecisionsPerDay, deviceId,
    shortCircuitOnFleetCapExceeded = false,
  } = params;
  const windowStart = sql`now() - interval '24 hours'`;

  const exposedDeviceRows = await db
    .select({ deviceId: aiUnattendedExposure.deviceId })
    .from(aiUnattendedExposure)
    .where(and(eq(aiUnattendedExposure.orgId, orgId), gt(aiUnattendedExposure.reservedAt, windowStart)));
  const exposedDevices = new Set(exposedDeviceRows.map((r) => r.deviceId));
  const deviceAlreadyExposed = deviceId !== undefined && exposedDevices.has(deviceId);

  const contractDeviceCount = await countContractDevices(orgId, null);
  const allowance = Math.floor((contractDeviceCount * maxFleetPercentPerDay) / 100);
  const distinctDevices = exposedDevices.size + (deviceId !== undefined && !deviceAlreadyExposed ? 1 : 0);

  let policyDecisionsToday: number | null = null;
  if (!shortCircuitOnFleetCapExceeded || distinctDevices <= allowance) {
    const [dayCountRow] = await db
      .select({ n: count() })
      .from(aiUnattendedExposure)
      .where(
        and(
          eq(aiUnattendedExposure.orgId, orgId),
          eq(aiUnattendedExposure.agentId, agentId),
          eq(aiUnattendedExposure.source, 'policy_intent'),
          gt(aiUnattendedExposure.reservedAt, windowStart),
        ),
      );
    policyDecisionsToday = Number(dayCountRow?.n ?? 0);
  }

  return {
    distinctDevices,
    allowance,
    contractDeviceCount,
    maxFleetPercentPerDay,
    policyDecisionsToday,
    maxPolicyDecisionsPerDay,
    windowHours: 24,
  };
}
