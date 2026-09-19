import { and, eq } from 'drizzle-orm';
import type { db } from '../db';
import { deviceCommands, users } from '../db/schema';
import {
  propagateCancelledDeviceCommands,
  type DeviceCommandCancelSubject,
} from './commandCancelPropagation';
import { assertDeviceExecuteAllowed, TrustDeniedError } from './partnerTrust.commands';
import { captureException } from './sentry';
import { terminalPayloadErasureSet } from './sensitiveCommandPayload';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Why a claim candidate was TERMINALISED. Deliberately a separate union from
 * `ClaimHoldReason`: a cancel writes a terminal row and erases its payload, a
 * hold leaves the row `pending` for the next heartbeat. Mixing them in one type
 * let a hold reason typecheck its way into `ClaimPartition.cancelled`.
 */
export type ClaimCancelReason =
  | 'device_moved_org'
  | 'device_lifecycle'
  | 'trust_denied'
  | 'requester_inactive'
  | 'submitter_org_erased';

/** Why a claim candidate was withheld this heartbeat but left `pending`. */
export type ClaimHoldReason =
  | 'held_maintenance_suppression'
  | 'power_state_barrier'
  | 'eligibility_check_failed';

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
  /**
   * Needed to terminalise the OWNING record when this row is cancelled here
   * (the `script_executions` id lives in `payload.executionId`). The caller
   * (`claimPendingCommandsForDevice`) selects whole `device_commands` rows, so
   * it is always present at runtime — `unknown` because that is what the jsonb
   * column's Drizzle type is; it is narrowed at the one place it is read.
   */
  payload: unknown;
};

export type ClaimPartition = {
  claimable: ClaimCandidate[];
  cancelled: Array<{ id: string; reason: ClaimCancelReason }>;
  held: Array<{ id: string; reason: ClaimHoldReason }>;
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
export const POWER_STATE_BARRIER_TYPES: ReadonlySet<string> = new Set(['reboot', 'shutdown', 'reboot_safe_mode']);

/**
 * Types the UNINSTALL DRAIN owns. Exempt from EVERY claim-time eligibility
 * cancel — lifecycle, partner trust, requester-active and org drift alike.
 *
 * Each of those checks answers "should this device still be asked to do work
 * for this tenant?", and for a removal the answer is always yes: the whole
 * point is to stop managing the machine. A Remove-with-uninstall is queued
 * against a device that is about to be (or already is) `decommissioned`, by a
 * tech who is frequently deactivated before the machine next checks in, and
 * often as part of the same offboarding that moves or erases the org. Cancel it
 * for any of those and the agent stays installed on a customer's box forever
 * (#3986; regression caught by deviceUninstallDrain.integration.test.ts).
 *
 * The drain is not unguarded: it carries its own deadline
 * (`device_remove_expires_at`, enforced by the reaper) and its own auth gate
 * (`agentAuth`'s 30-minute drain window). The only claim-time rules that still
 * apply to it are the caller's `deliver_by` predicate and the power-state
 * barrier — neither of which can strand it.
 */
const DRAIN_EXEMPT_TYPES: ReadonlySet<string> = new Set(['self_uninstall']);

/** Device states in which ordinary queued work must never be delivered. */
const NON_DELIVERABLE_LIFECYCLE: ReadonlySet<string> = new Set(['decommissioned', 'quarantined']);

/**
 * Per-type "hold" predicates: `true` = leave the row `pending` this heartbeat
 * and re-evaluate on the next one. W3 registers `install_patches` here so an
 * install is not delivered inside an active `suppressPatching` window.
 */
export type TypeHold = (deviceId: string) => Promise<boolean>;

export const typeHolds: Record<string, TypeHold> = {};

/**
 * Register a per-type hold. Refuses to overwrite: two modules silently
 * competing for one command type is how a suppression window stops being
 * applied — the last import order wins and nothing reports it.
 */
export function registerTypeHold(type: string, hold: TypeHold): void {
  if (typeHolds[type]) {
    throw new Error(`A claim-time hold is already registered for "${type}"`);
  }
  typeHolds[type] = hold;
}

/** Test-only: drop every registered hold so a suite can install its own. */
export function __resetTypeHoldsForTests(): void {
  for (const key of Object.keys(typeHolds)) delete typeHolds[key];
}

/**
 * #5128 review round 2 (N) — the eligibility-fault capture below runs per ROW,
 * per heartbeat, per device. A partner-trust outage would turn one fault into
 * thousands of identical Sentry events per minute. Throttled per device;
 * `console.error` is deliberately NOT throttled, since the logs are where the
 * per-row detail belongs.
 */
const ELIGIBILITY_FAULT_REPORT_WINDOW_MS = 10 * 60 * 1000;
const eligibilityFaultLastReported = new Map<string, number>();

function shouldReportEligibilityFault(deviceId: string, now: number): boolean {
  const last = eligibilityFaultLastReported.get(deviceId);
  if (last !== undefined && now - last < ELIGIBILITY_FAULT_REPORT_WINDOW_MS) return false;
  eligibilityFaultLastReported.set(deviceId, now);
  return true;
}

/** Test-only: clear the per-device Sentry throttle. */
export function __resetEligibilityFaultThrottleForTests(): void {
  eligibilityFaultLastReported.clear();
}

/**
 * Splits claim candidates into claimable / cancelled / held (#5128 §G).
 *
 * A queued command may be claimed days after it was requested, so the
 * authorization and targeting facts that were true at request time have to be
 * re-checked at delivery. Cancels are written INSIDE the caller's claim
 * transaction, so a row this function cancels can never be delivered by a
 * concurrent claim.
 *
 * KNOWN RESIDUAL — this does NOT serialise against a concurrent org move. The
 * claim reads `devices` without `FOR UPDATE` (deliberately: taking a row-
 * exclusive lock on the device on every heartbeat would serialise the hottest
 * path in the product against every other write to that row). So a move that
 * commits between this read and the claim's status flip can leave one command
 * delivered just after the device changed org — the move's own pending-row
 * sweep then misses it because the row is already `sent`. Closing this needs
 * the claim to lock `devices` before `device_commands` (matching org-move's
 * order, since the reverse would deadlock); deferred rather than risking
 * heartbeat contention here. The window is a few milliseconds and the blast
 * radius is one command inside the same partner.
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
  const held: Array<{ id: string; reason: ClaimHoldReason }> = [];
  const requesterActive = new Map<string, boolean>();

  for (const row of rows) {
    // Checked FIRST, ahead of every cancel: see DRAIN_EXEMPT_TYPES above.
    if (DRAIN_EXEMPT_TYPES.has(row.type)) {
      claimable.push(row);
      continue;
    }

    const submittedOrgId = row.submittedOrgId ?? null;
    if (submittedOrgId !== null && submittedOrgId !== device.orgId) {
      cancelled.push({ id: row.id, reason: 'device_moved_org' });
      continue;
    }
    // A NULL `submitted_org_id` means one of two very different things, and the
    // deadline tells them apart:
    //
    //  - `deliver_by IS NULL`  -> a LEGACY row, written before #5128 added the
    //    column. No recorded org is not evidence of a move; deliver it.
    //  - `deliver_by IS NOT NULL` -> a post-#5128 row. Every enqueue path stamps
    //    `submitted_org_id` from the device's org, so a NULL here can only have
    //    come from the FK's ON DELETE SET NULL — i.e. THE ORIGINATING ORG WAS
    //    DELETED. That erases the very fact the org check compares against, so
    //    the check would silently pass. Refuse instead: this is the residual
    //    the org-merge path leaves behind (the loser org survives as a shell,
    //    is later erased, and the row's provenance goes NULL underneath a
    //    device that has since been repointed to the surviving org).
    if (submittedOrgId === null && row.deliverBy !== null && row.deliverBy !== undefined) {
      cancelled.push({ id: row.id, reason: 'submitter_org_erased' });
      continue;
    }

    if (NON_DELIVERABLE_LIFECYCLE.has(device.status)) {
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
      // A failure of the trust check must NEVER be read as "allowed" — but it
      // must not take the heartbeat down with it either. This runs inside the
      // claim transaction of `claimPendingCommandsForDevice`, which the agent
      // heartbeat awaits; rethrowing aborts that transaction and 500s the
      // heartbeat, and because the row stays `pending` it is re-selected on
      // every subsequent heartbeat — turning one deterministic fault into a
      // device that can never check in again. HOLD the row instead: not
      // delivered (fail-closed), not cancelled (recoverable), and the rest of
      // the batch still goes out.
      console.error(
        '[commandClaimEligibility] trust check failed; holding the command rather than delivering or cancelling it',
        {
          commandId: row.id,
          deviceId: device.id,
          type: row.type,
          error: e instanceof Error ? e.message : String(e),
        },
      );
      if (shouldReportEligibilityFault(device.id, Date.now())) {
        captureException(e instanceof Error ? e : new Error(String(e)));
      }
      held.push({ id: row.id, reason: 'eligibility_check_failed' });
      continue;
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
  const power = claimable.filter((r) => POWER_STATE_BARRIER_TYPES.has(r.type));
  if (power.length > 0) {
    const others = claimable.filter((r) => !POWER_STATE_BARRIER_TYPES.has(r.type));
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
    const byId = new Map(rows.map((r) => [r.id, r]));
    const flipped: DeviceCommandCancelSubject[] = [];
    for (const c of cancelled) {
      const [updated] = await tx
        .update(deviceCommands)
        .set({
          status: 'cancelled',
          completedAt,
          result: { status: 'cancelled', reason: c.reason, cancelledBy: 'claim_eligibility' },
          ...terminalPayloadErasureSet(),
        })
        // CAS on `pending`: a row that was claimed between the SELECT and here
        // must not be terminalised out from under its delivery.
        .where(and(eq(deviceCommands.id, c.id), eq(deviceCommands.status, 'pending')))
        .returning({ id: deviceCommands.id });
      // Only a row this UPDATE actually flipped is ours to propagate. A row
      // that lost the CAS is being DELIVERED by a concurrent claim — cancelling
      // its script_executions / deployment_results row would terminalise work
      // that is about to run on the machine.
      if (!updated) continue;
      const source = byId.get(c.id);
      if (!source) continue;
      const payload =
        source.payload && typeof source.payload === 'object' && !Array.isArray(source.payload)
          ? (source.payload as Record<string, unknown>)
          : null;
      flipped.push({ id: c.id, type: source.type, payload });
    }
    // Terminalise the OWNING records too, in this same transaction. Without
    // this a cancelled command leaves its script_executions / deployment_results
    // row `pending` forever: the command reaper only scans `pending`/`sent`
    // commands, so nothing would ever revisit it. Same contract as the
    // cancel-on-event sweeps (routes/devices/moveOrg.ts, core.ts).
    if (flipped.length > 0) {
      await propagateCancelledDeviceCommands(flipped, completedAt, tx);
    }
  }

  return { claimable, cancelled, held };
}
