import { and, eq } from 'drizzle-orm';
import type { db } from '../db';
import { deviceCommands, users } from '../db/schema';
import { assertDeviceExecuteAllowed, TrustDeniedError } from './partnerTrust.commands';
import { terminalPayloadErasureSet } from './sensitiveCommandPayload';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type ClaimCancelReason =
  | 'device_moved_org'
  | 'device_lifecycle'
  | 'trust_denied'
  | 'requester_inactive'
  | 'held_maintenance_suppression'
  | 'power_state_barrier';

/**
 * The device facts claim-time eligibility needs. Deliberately NOT carrying a
 * partner id: `devices` has no `partner_id` column (partner ownership is
 * resolved through the org), and `assertDeviceExecuteAllowed` does that
 * resolution itself.
 */
export type ClaimEligibilityDevice = {
  id: string;
  orgId: string;
  status: string;
};

export type ClaimCandidate = {
  id: string;
  type: string;
  createdBy: string | null;
  submittedOrgId: string | null;
  deliverBy: Date | null;
};

export type ClaimPartition = {
  claimable: ClaimCandidate[];
  cancelled: Array<{ id: string; reason: ClaimCancelReason }>;
  held: Array<{ id: string; reason: ClaimCancelReason }>;
};

/**
 * Disruptive power-state changes. Claimed alone and only when nothing else is
 * in flight (#5128 §E.4): the agent runs non-interactive commands concurrently
 * (heartbeat worker pool, per-command goroutines), so FIFO order alone cannot
 * stop a queued reboot from landing in the middle of a script.
 *
 * `schedule_reboot` is deliberately NOT here — it only asks the agent to
 * schedule a restart (with its own delay and user deferral), so it does not
 * need to be serialised against other work.
 */
export const POWER_STATE_TYPES: ReadonlySet<string> = new Set(['reboot', 'shutdown', 'reboot_safe_mode']);

/** Types exempt from lifecycle cancellation: the uninstall drain must still deliver. */
const LIFECYCLE_EXEMPT: ReadonlySet<string> = new Set(['self_uninstall']);

/** Device states in which ordinary queued work must never be delivered. */
const NON_DELIVERABLE_LIFECYCLE: ReadonlySet<string> = new Set(['decommissioned', 'quarantined']);

/**
 * Per-type "hold" predicates: `true` = leave the row `pending` this heartbeat
 * and re-evaluate on the next one. W3 registers `install_patches` here so an
 * install is not delivered inside an active `suppressPatching` window.
 */
export const typeHolds: Record<string, (deviceId: string) => Promise<boolean>> = {};

/**
 * Splits claim candidates into claimable / cancelled / held (#5128 §G).
 *
 * A queued command may be claimed days after it was requested, so the
 * authorization and targeting facts that were true at request time have to be
 * re-checked at delivery. Cancels are written INSIDE the caller's claim
 * transaction, so a row this function cancels can never be delivered by a
 * concurrent claim — and the device row lock the claim already holds
 * (`FOR UPDATE`) is what serialises an in-flight org move against this check.
 *
 * `held` rows are left `pending` and untouched; `cancelled` rows are terminal
 * with their payload erased.
 *
 * NOT re-checked in v1 (OD-4, deferred to W6 behind #3985): full rehydration of
 * the requester's current org/site/action permissions, and script edit/delete
 * (the payload is an immutable snapshot — editing a script must never
 * substitute the code a queued run will execute).
 */
export async function partitionClaimable(
  tx: Tx,
  device: ClaimEligibilityDevice,
  rows: ClaimCandidate[],
  opts: { inFlight?: number } = {},
): Promise<ClaimPartition> {
  const claimable: ClaimCandidate[] = [];
  const cancelled: Array<{ id: string; reason: ClaimCancelReason }> = [];
  const held: Array<{ id: string; reason: ClaimCancelReason }> = [];
  const requesterActive = new Map<string, boolean>();

  for (const row of rows) {
    // Legacy rows predate `submitted_org_id`; a NULL means "no recorded org",
    // which is not evidence of a move and must not cancel the row. `undefined`
    // is treated the same way — an absent value is not a mismatch.
    const submittedOrgId = row.submittedOrgId ?? null;
    if (submittedOrgId !== null && submittedOrgId !== device.orgId) {
      cancelled.push({ id: row.id, reason: 'device_moved_org' });
      continue;
    }

    if (NON_DELIVERABLE_LIFECYCLE.has(device.status) && !LIFECYCLE_EXEMPT.has(row.type)) {
      cancelled.push({ id: row.id, reason: 'device_lifecycle' });
      continue;
    }

    try {
      await assertDeviceExecuteAllowed(device.id, row.type, row.createdBy ?? undefined);
    } catch (e) {
      if (e instanceof TrustDeniedError) {
        cancelled.push({ id: row.id, reason: 'trust_denied' });
        continue;
      }
      // A transient failure of the trust check must NOT be read as "allowed".
      throw e;
    }

    if (row.createdBy) {
      let active = requesterActive.get(row.createdBy);
      if (active === undefined) {
        const [u] = await tx
          .select({ status: users.status })
          .from(users)
          .where(eq(users.id, row.createdBy))
          .limit(1);
        active = u?.status === 'active';
        requesterActive.set(row.createdBy, active);
      }
      if (!active) {
        cancelled.push({ id: row.id, reason: 'requester_inactive' });
        continue;
      }
    }

    const hold = typeHolds[row.type];
    if (hold && (await hold(device.id))) {
      held.push({ id: row.id, reason: 'held_maintenance_suppression' });
      continue;
    }

    claimable.push(row);
  }

  // Power-state barrier. Runs over the SURVIVORS only, so a reboot that was
  // cancelled above never consumes the single slot.
  const power = claimable.filter((r) => POWER_STATE_TYPES.has(r.type));
  if (power.length > 0) {
    const others = claimable.filter((r) => !POWER_STATE_TYPES.has(r.type));
    const inFlight = opts.inFlight ?? 0;
    if (others.length > 0 || inFlight > 0) {
      for (const p of power) held.push({ id: p.id, reason: 'power_state_barrier' });
      claimable.splice(0, claimable.length, ...others);
    } else {
      claimable.splice(0, claimable.length, power[0]!);
      for (const p of power.slice(1)) held.push({ id: p.id, reason: 'power_state_barrier' });
    }
  }

  if (cancelled.length > 0) {
    const completedAt = new Date();
    for (const c of cancelled) {
      await tx
        .update(deviceCommands)
        .set({
          status: 'cancelled',
          completedAt,
          result: { status: 'cancelled', reason: c.reason, cancelledBy: 'claim_eligibility' },
          ...terminalPayloadErasureSet(),
        })
        // CAS on `pending`: a row that was claimed between the SELECT and here
        // must not be terminalised out from under its delivery.
        .where(and(eq(deviceCommands.id, c.id), eq(deviceCommands.status, 'pending')));
    }
  }

  return { claimable, cancelled, held };
}
