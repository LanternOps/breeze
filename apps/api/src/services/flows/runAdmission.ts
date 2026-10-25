/**
 * Tool catalog W04 (#5219), plan Task A8 / Decision 8 — run slots and the
 * active-run cap.
 *
 * A slot is a THROUGHPUT limiter, not mutual exclusion of effects: at most one
 * `running` run per (flow, org) and at most `flowMaxRunningPerOwner()`
 * running runs per flow owner. Parked runs (`waiting`, `awaiting_approval`)
 * hold no slot; an approved step released by the intent release worker runs
 * outside it (Decision 8 rationale).
 *
 * `claimRunSlot` decides under a per-owner advisory transaction lock, so two
 * replicas can never both admit the 21st run. It is called by a slice that
 * already holds the run's lease and every write is conditional on that token.
 * A run that is ALREADY `running` (a stalled slice redelivered under a fresh
 * lease) holds its own slot: refusing it would leave a run counted against
 * the cap that can never be admitted again (review round "resume/stalled slot
 * deadlock").
 */
import { flowMaxRunningPerOwner } from '../../config/env';
import { getCurrentDbAccessContext, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import type { ToolOwnerRef } from '../toolSources/resolver';
import * as store from './runStore';

/** W05 widens this with budget / monthly-cap codes. */
export type FlowRunAdmissionRefusal = 'flow_queue_full';

/** Active = queued + running + waiting + awaiting_approval, per flow owner (Decision 8). */
export const FLOW_MAX_ACTIVE_RUNS_PER_OWNER = 1000;

const ADMITTABLE: ReadonlySet<string> = new Set(['queued', 'waiting', 'awaiting_approval']);

function inSystemTx<T>(fn: () => Promise<T>, label: string): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn, label));
}

export async function claimRunSlot(
  run: { id: string; flowId: string; orgId: string },
  owner: ToolOwnerRef,
  token: string,
): Promise<boolean> {
  return inSystemTx(async () => {
    await store.lockOwnerSlots(store.flowOwnerKey(owner));
    const snap = await store.loadSlotSnapshot(run, owner);
    // Never decide for a run whose lease is no longer ours.
    if (!snap.self || snap.self.leaseToken !== token) return false;
    if (snap.self.status === 'running') return true;
    if (!ADMITTABLE.has(snap.self.status)) return false;
    if (snap.otherRunningForFlowOrg) return false;
    if (snap.ownerRunning >= flowMaxRunningPerOwner()) return false;
    return store.casRunToRunning(run.id, token);
  }, 'flows.runAdmission.claimRunSlot');
}

/**
 * Joins an ambient SYSTEM transaction (run creation, Task A9, counts inside
 * the transaction that inserts — no second pooled connection per event);
 * otherwise opens a fresh short one.
 */
export async function assertActiveCapacity(
  owner: ToolOwnerRef,
): Promise<{ ok: true } | { ok: false; error: 'flow_queue_full' }> {
  const active = getCurrentDbAccessContext()?.scope === 'system'
    ? await store.countActiveRunsForOwner(owner)
    : await inSystemTx(() => store.countActiveRunsForOwner(owner), 'flows.runAdmission.activeCapacity');
  return active < FLOW_MAX_ACTIVE_RUNS_PER_OWNER ? { ok: true } : { ok: false, error: 'flow_queue_full' };
}

/**
 * The admission seam every run creation calls (Task A9). W04: exactly the
 * active-run cap. W05 adds per-flow budgets and monthly caps here.
 */
export async function assertFlowRunAdmission(
  owner: ToolOwnerRef,
  _flowId: string,
): Promise<{ ok: true } | { ok: false; error: FlowRunAdmissionRefusal }> {
  return assertActiveCapacity(owner);
}
