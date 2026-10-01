/**
 * Legacy → registry cutover (#7601 Task 6A; W02 handoff item 1 as revised by
 * review findings 7–10).
 *
 * A partner is projected from legacy config EXACTLY ONCE, durably, before any
 * registry-routed dispatch for it: W02's reconcile and the partner's
 * ai_model_registry_partner_cutover row commit in one transaction or not at
 * all. The resolver gates on that row (ensurePartnerCutover), so every
 * entrypoint — API, split worker, any future consumer — is covered without a
 * boot barrier. A leased background sweep, started after serve() /
 * startRegisteredWorkers, cuts the rest of the fleet over; /health is never
 * blocked.
 */
import { randomUUID } from 'node:crypto';
import { captureException } from '../sentry';
import { reconcilePartnerFromLegacyInTx } from './legacyReconcile';
import {
  disableUnproducedOfferings,
  hasCutoverRow,
  markComplete,
  nextUncutPartners,
  releaseLease,
  renewLease,
  takeLease,
  withPartnerCutoverTx,
} from './registryCutoverStore';
import { carriesQueryValues, safeErrorMessage } from './safeDbError';

export type PartnerCutoverResult = 'done' | 'already';

export interface RegistryCutoverSweepResult {
  outcome: 'not_coordinator' | 'complete' | 'incomplete';
  processed: number;
  failed: string[];
}

/** A Drizzle/postgres error carries the statement's bound values: report only its safe fields. */
export function reportableCutoverError(error: unknown): unknown {
  return carriesQueryValues(error) ? new Error(`AI model registry cutover failed: ${safeErrorMessage(error)}`) : error;
}

function report(error: unknown, partnerId?: string): void {
  captureException(reportableCutoverError(error), undefined, {
    area: 'ai_model_registry_cutover',
    ...(partnerId ? { partnerId } : {}),
  });
}

export async function cutoverPartner(
  partnerId: string,
  deps: { reconcileInTx?: typeof reconcilePartnerFromLegacyInTx } = {},
): Promise<PartnerCutoverResult> {
  let result: PartnerCutoverResult = 'already';
  await withPartnerCutoverTx(partnerId, async (exists) => {
    if (exists) return;
    const projected = await (deps.reconcileInTx ?? reconcilePartnerFromLegacyInTx)(partnerId);
    // Same transaction, after the projection: nothing the projection did not
    // produce may stay enabled into the registry-authoritative world, where an
    // `all` permitted set or a picker would expose it (registryCutoverStore.ts).
    await disableUnproducedOfferings(partnerId, projected.producedOfferingIds);
    result = 'done';
  });
  return result;
}

/** Partners known cut over in this process. A row is never removed, so the memo cannot go stale. */
const cutOver = new Set<string>();

export function __resetRegistryCutoverMemoForTests(): void {
  cutOver.clear();
}

/** Task 6B's facade gate: true once the partner's cutover row exists. */
export async function isPartnerCutOver(partnerId: string): Promise<boolean> {
  if (cutOver.has(partnerId)) return true;
  if (await hasCutoverRow(partnerId)) {
    cutOver.add(partnerId);
    return true;
  }
  return false;
}

/** The resolver gate. false = the partner could not be cut over now; the caller refuses (recoverable). */
export async function ensurePartnerCutover(partnerId: string): Promise<boolean> {
  try {
    if (await isPartnerCutOver(partnerId)) return true;
    await cutoverPartner(partnerId);
    cutOver.add(partnerId);
    return true;
  } catch (error) {
    report(error, partnerId);
    return false;
  }
}

export async function runRegistryCutoverSweep(opts: {
  owner?: string;
  leaseMs?: number;
  batch?: number;
  deps?: { cutover?: typeof cutoverPartner };
} = {}): Promise<RegistryCutoverSweepResult> {
  const owner = opts.owner ?? `sweep-${randomUUID()}`;
  const leaseMs = opts.leaseMs ?? 5 * 60_000;
  const batch = opts.batch ?? 50;
  const cutover = opts.deps?.cutover ?? cutoverPartner;

  const lease = await takeLease(owner, leaseMs);
  if (lease === 'complete') return { outcome: 'complete', processed: 0, failed: [] };
  if (lease === 'held') return { outcome: 'not_coordinator', processed: 0, failed: [] };

  const failed: string[] = [];
  let processed = 0;
  let completed = false;
  let after: string | null = null;
  try {
    for (;;) {
      const ids = await nextUncutPartners(after, batch);
      if (ids.length === 0) break;
      for (const partnerId of ids) {
        try {
          if ((await cutover(partnerId)) === 'done') processed += 1;
          cutOver.add(partnerId);
        } catch (error) {
          // Un-rowed: the next sweep or the partner's next AI request retries it.
          failed.push(partnerId);
          report(error, partnerId);
        }
        if (!(await renewLease(owner, leaseMs))) return { outcome: 'not_coordinator', processed, failed };
        after = partnerId;
      }
    }
    if (failed.length > 0) return { outcome: 'incomplete', processed, failed };
    if (!(await markComplete(owner))) return { outcome: 'not_coordinator', processed, failed };
    completed = true;
    return { outcome: 'complete', processed, failed };
  } finally {
    // markComplete already cleared the lease. Otherwise hand it back now so the
    // next boot's sweep need not wait out the expiry; owner-guarded, so a lease
    // another process took over is never touched.
    if (!completed) await releaseLease(owner).catch((error) => report(error));
  }
}
