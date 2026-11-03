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
import type { FlowAdmissionRefusal, FlowDocumentV1 } from '@breeze/shared';
import { flowMaxRunningPerOwner } from '../../config/env';
import { getCurrentDbAccessContext, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import type { ToolOwnerRef } from '../toolSources/resolver';
import { readFlowUsage } from './budgets';
import { effectiveFlowMonthlyCap, resolveFlowLimits } from './flowLimits';
import * as store from './runStore';

/** The active-run cap (W04) and the monthly caps (W05, Decision 15). */
export type FlowRunAdmissionRefusal = FlowAdmissionRefusal;

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
 * The admission seam every run creation calls (W04 Task A9, W05 Task A4):
 *  1. the active-run cap (W04);
 *  2. a read-only monthly pre-check — refuse early when this month is already
 *     at the flow's cap (owner's per-flow value, lowered by the document's
 *     `limits.monthlyRuns`) or the owner's cap.
 * Returns the caps `chargeFlowRun` enforces after the insert. Called by
 * `createFlowRun` under the owner's admission lock inside its system
 * transaction, so the pre-check and the charge see the same counts.
 */
export async function assertFlowRunAdmission(
  owner: ToolOwnerRef,
  flowId: string,
  ctx: { doc: Pick<FlowDocumentV1, 'limits'>; at: Date },
): Promise<{ ok: true; caps: { flowCap: number; ownerCap: number } } | { ok: false; error: FlowRunAdmissionRefusal }> {
  const active = await assertActiveCapacity(owner);
  if (!active.ok) return active;
  const limits = await resolveFlowLimits(owner);
  const flowCap = effectiveFlowMonthlyCap(limits, ctx.doc);
  const ownerCap = limits.monthlyRunsPerOwner;
  const usage = await readFlowUsage(flowId, owner, ctx.at);
  if (usage.flowRuns >= flowCap) return { ok: false, error: 'flow_monthly_cap_reached' };
  if (usage.ownerRuns >= ownerCap) return { ok: false, error: 'owner_monthly_cap_reached' };
  return { ok: true, caps: { flowCap, ownerCap } };
}
