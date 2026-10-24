import { and, eq, gt, inArray, isNull, notInArray, or, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { deviceCommands, devices, organizations, peripheralPolicyDeviceStates } from '../db/schema';
import {
  partitionClaimable,
  POWER_STATE_BARRIER_TYPES,
  type ClaimCancelReason,
  type ClaimHoldReason,
} from './commandClaimEligibility';
import { isTransientLockError, pgErrorCode } from '../utils/pgErrors';
import { terminalPayloadErasureSet } from './sensitiveCommandPayload';
import { isUnassignedPoolOrgType } from './unassignedPool/orgType';
import {
  commandIncarnationAcceptedForCallerCondition,
  commandIncarnationIsCurrentCondition,
  commandStampMatchesCaller,
  commandStampMatchesCallerCondition,
  type CommandCallerIncarnation,
} from './commandIncarnation';
// Side-effect import: registers the `network_diagnostic` delivery
// revalidation. Both delivery legs live in this module, so this is the one
// place that guarantees it is loaded. `REVALIDATION_REQUIRED_TYPES` still
// fails the row closed if it ever is not.
import './topology/diagnosticDispatch';
// Side-effect import: registers the `topology_interface_poll` revalidation (M3-D2).
import './topology/telemetryPollDelivery';
// Side-effect import: registers the `script` delivery revalidation (rehydrates
// the requester's live RBAC — role/org-access/site — at claim time, same
// rationale as the diagnostic import above).
import './scriptCommandRevalidation';

type DeviceCommandRow = typeof deviceCommands.$inferSelect;

/** Refused rows a parked device's claim cancels per heartbeat; the rest go on the next one. */
const PARKED_REFUSED_CANCEL_BATCH = 100;

/**
 * What the single-command (WebSocket push) claim did with the row.
 *
 * - `claimed`: flipped to `sent`; the caller now owns delivering it (or
 *   releasing the claim). `agentId` is the device's `agent_id` as read IN the
 *   claim (#8318 §6.4): the push goes to that identity, never to one read
 *   before the claim, so a reattach that committed in between is honoured.
 * - `cancelled`: claim-time eligibility TERMINALISED the row (and its owning
 *   record) exactly as the heartbeat claim would. Terminal: never deliver it,
 *   never wait for a result, and surface `reason` to the requester.
 * - `held`: left `pending` for the next heartbeat claim (an eligibility lookup
 *   failed, a per-type hold or the power-state barrier applies, or the claim
 *   lost a lock race to a concurrent writer — `claim_lock_conflict`).
 * - `not_claimable`: nothing done here — the row is gone, no longer `pending`,
 *   past its deadline, invisible to this context, or locked by a concurrent
 *   claim (which then owns its delivery).
 */
export type PushClaimOutcome =
  | { status: 'claimed'; id: string; executedAt: Date; agentId: string }
  | { status: 'cancelled'; id: string; reason: ClaimCancelReason }
  | { status: 'held'; id: string; reason: ClaimHoldReason | 'claim_lock_conflict' }
  | { status: 'not_claimable'; id: string };

export async function claimPendingCommandForDelivery(
  commandId: string,
  executedAt: Date = new Date(),
): Promise<PushClaimOutcome> {
  // device_commands is system-scoped (agent WS path) and this runs from
  // executeCommand's runOutsideDbContext block — establish a system context so
  // the write isn't a contextless bare-pool write (#1375 warning flood).
  // The whole claim runs on ONE connection: the system context's transaction
  // (or the caller's own context, which withSystemDbAccessContext joins), in a
  // savepoint so `partitionClaimable` gets a real transaction handle for its
  // own savepointed resolver reads. Nothing below opens a second pooled
  // connection (#1105, #7919).
  //
  // The savepoint also bounds a lost lock race. A cancel here terminalises the
  // owning record (script_executions / deployment_results / patch_job_results)
  // after locking the command row, while an org move locks those children
  // first (its devices cascade) and the command rows after — so the two can
  // deadlock. Postgres then aborts one side; if it is this one, the savepoint
  // rolls back (the row stays `pending`, untouched) and the push reports
  // `held` so the next heartbeat re-evaluates it, instead of failing the
  // caller's request.
  return withSystemDbAccessContext(async () => {
    try {
      return await claimInSavepoint(commandId, executedAt);
    } catch (err) {
      if (!isTransientLockError(err)) throw err;
      console.warn('[commandDispatch] push claim lost a lock race; leaving the command pending', {
        commandId,
        code: pgErrorCode(err),
      });
      return { status: 'held', id: commandId, reason: 'claim_lock_conflict' } as const;
    }
  });
}

async function claimInSavepoint(commandId: string, executedAt: Date): Promise<PushClaimOutcome> {
  return db.transaction(async (tx): Promise<PushClaimOutcome> => {
    // The WebSocket push applies EXACTLY the claim-time eligibility the
    // heartbeat claim applies (`partitionClaimable`): parked-org, org drift
    // (`submitted_org_id` vs the device's CURRENT org), erased submitter org,
    // device lifecycle, partner trust, requester still active, the per-type
    // delivery revalidation, per-type holds and the power-state barrier. A row
    // it cancels is terminalised (and its owning record propagated) on this
    // transaction with the same `result` the heartbeat writes; a held row stays
    // `pending` for the next heartbeat.
    //
    // Same row selection as the heartbeat scan: `pending`, inside its delivery
    // deadline (a past-deadline row is the reaper's), locked
    // `FOR UPDATE ... SKIP LOCKED` on the command row only. A row a concurrent
    // heartbeat claim holds is skipped here (and vice versa), so the two legs
    // never evaluate or deliver the same row at once. Inner joins: a row whose
    // device or org this context cannot see is not delivered here.
    const now = executedAt;
    const [candidate] = await tx
      .select({
        id: deviceCommands.id,
        type: deviceCommands.type,
        deviceId: deviceCommands.deviceId,
        payload: deviceCommands.payload,
        createdBy: deviceCommands.createdBy,
        submittedOrgId: deviceCommands.submittedOrgId,
        deliverBy: deviceCommands.deliverBy,
        targetRole: deviceCommands.targetRole,
        deviceIncarnation: deviceCommands.deviceIncarnation,
        deviceOrgId: devices.orgId,
        deviceStatus: devices.status,
        deviceInstallIncarnation: devices.installIncarnation,
        // #8318 §6.4: the identity the push is addressed to, read with the
        // incarnation it is compared against — never one read before the claim.
        deviceAgentId: devices.agentId,
        orgType: organizations.type,
      })
      .from(deviceCommands)
      .innerJoin(devices, eq(devices.id, deviceCommands.deviceId))
      .innerJoin(organizations, eq(organizations.id, devices.orgId))
      .where(
        and(
          eq(deviceCommands.id, commandId),
          eq(deviceCommands.status, 'pending'),
          or(isNull(deviceCommands.deliverBy), gt(deviceCommands.deliverBy, now)),
        ),
      )
      .limit(1)
      .for('update', { of: deviceCommands, skipLocked: true });
    if (!candidate) return { status: 'not_claimable', id: commandId };

    // The power-state barrier needs the device's in-flight count; only read it
    // when the candidate is a power-state command (it is ignored otherwise).
    let inFlight = 0;
    if (POWER_STATE_BARRIER_TYPES.has(candidate.type)) {
      const [inFlightRow] = await tx
        .select({ inFlight: sql<number>`count(*)::int` })
        .from(deviceCommands)
        .where(
          and(
            eq(deviceCommands.deviceId, candidate.deviceId),
            eq(deviceCommands.status, 'sent'),
            eq(deviceCommands.targetRole, candidate.targetRole),
          ),
        )
        .limit(1);
      inFlight = inFlightRow?.inFlight ?? 0;
    }

    const { claimable, cancelled, held } = await partitionClaimable(
      tx,
      {
        id: candidate.deviceId,
        orgId: candidate.deviceOrgId,
        status: candidate.deviceStatus,
        orgType: candidate.orgType,
        installIncarnation: candidate.deviceInstallIncarnation,
      },
      [
        {
          id: candidate.id,
          type: candidate.type,
          deviceIncarnation: candidate.deviceIncarnation,
          createdBy: candidate.createdBy,
          submittedOrgId: candidate.submittedOrgId,
          deliverBy: candidate.deliverBy,
          payload: candidate.payload,
        },
      ],
      { inFlight },
    );
    const cancel = cancelled.find((c) => c.id === candidate.id);
    if (cancel) return { status: 'cancelled', id: commandId, reason: cancel.reason };
    const hold = held.find((h) => h.id === candidate.id);
    if (hold) return { status: 'held', id: commandId, reason: hold.reason };
    if (!claimable.some((c) => c.id === candidate.id)) return { status: 'not_claimable', id: commandId };

    const flipped = await tx
      .update(deviceCommands)
      .set({ status: 'sent', executedAt })
      .where(
        and(
          eq(deviceCommands.id, commandId),
          eq(deviceCommands.status, 'pending'),
          // #5128: never deliver a row the reaper is about to expire. A row
          // whose deadline has passed stays `pending` for the reaper to
          // terminalise with `reason: not_delivered_before_deadline`.
          or(isNull(deviceCommands.deliverBy), gt(deviceCommands.deliverBy, executedAt)),
          // #8318: the incarnation, re-read in the flip itself, so a reattach
          // that committed after the eligibility read above still wins. The
          // server push has no caller incarnation of its own: it compares the
          // stamp with the incarnation read in this claim, and the push below
          // goes to the agent_id read with it.
          commandIncarnationIsCurrentCondition(),
          commandStampMatchesCallerCondition({ installIncarnation: candidate.deviceInstallIncarnation }),
          // #8318 §6.4: the agent_id the push is addressed to, re-checked in
          // the same statement. The candidate read locks the command row only,
          // and an in-place F3 re-enroll (routes/agents/enrollment.ts) changes
          // `agent_id` WITHOUT advancing `install_incarnation`, so the
          // incarnation re-check above cannot see it. A row whose device
          // changed hands since the read stays `pending` for the new install.
          sql`EXISTS (SELECT 1 FROM ${devices} WHERE ${devices.id} = ${deviceCommands.deviceId} AND ${devices.agentId} = ${candidate.deviceAgentId})`,
        ),
      )
      .returning({ id: deviceCommands.id });
    return flipped.length > 0
      ? { status: 'claimed', id: commandId, executedAt, agentId: candidate.deviceAgentId }
      : { status: 'not_claimable', id: commandId };
  });
}

/**
 * How many commands this device already has in flight (`sent`, awaiting a
 * result). Same predicate the heartbeat claim uses for the power-state barrier,
 * so the enqueue-time push and the heartbeat claim agree on when a reboot may
 * go out (#5128 §E.4).
 */
export async function countInFlightCommandsForDevice(
  deviceId: string,
  targetRole: string = 'agent',
): Promise<number> {
  const rows = await withSystemDbAccessContext(() =>
    db
      .select({ inFlight: sql<number>`count(*)::int` })
      .from(deviceCommands)
      .where(
        and(
          eq(deviceCommands.deviceId, deviceId),
          eq(deviceCommands.status, 'sent'),
          eq(deviceCommands.targetRole, targetRole),
        ),
      )
      .limit(1),
  );
  return rows[0]?.inFlight ?? 0;
}

/**
 * Put a claimed-but-undelivered command back to `pending`. Keyed on
 * `(id, status='sent', executedAt=<claim ts>)` so a stale release can never
 * clobber a newer claim or resurrect a terminal command (0-row no-op is the
 * correct outcome in both cases).
 *
 * Context note: `withSystemDbAccessContext` does NOT escalate when a request
 * context is already active — on the heartbeat paths (#2414) this UPDATE runs
 * inside the caller's org-scoped transaction. That is safe solely because
 * `device_commands` is intentionally RLS-free; if it ever gains a system-only
 * write policy, this release would become a silent 0-row no-op on the hottest
 * delivery path.
 */
export async function releaseClaimedCommandDelivery(
  commandId: string,
  executedAt: Date,
  /** Why delivery was deferred, kept on the row for the stale reaper to report. */
  deferral?: string,
): Promise<void> {
  await withSystemDbAccessContext(() =>
    db
      .update(deviceCommands)
      .set(
        deferral === undefined
          ? { status: 'pending', executedAt: null }
          : { status: 'pending', executedAt: null, result: { deliveryDeferred: deferral } },
      )
      .where(
        and(
          eq(deviceCommands.id, commandId),
          eq(deviceCommands.status, 'sent'),
          eq(deviceCommands.executedAt, executedAt),
        ),
      ),
  );
}

/**
 * Put a claimed command whose delivery was REFUSED back to `pending` with a
 * delivery deadline of "now", recording why in `result.deliveryRefusal`.
 *
 * Why not a plain release: a refusal (a storage destination reference that no
 * longer resolves, say) is permanent, so a released row would be re-claimed
 * and refused on every heartbeat until its execution clock ran out — up to 24
 * hours for a whole-machine restore. Why not a terminal write here: the stale
 * reaper's delivery clock is the one owner of "never delivered" propagation
 * (restore jobs, DR executions, script and patch records). A `deliver_by` in
 * the past is excluded by every claim query and picked up by that clock on its
 * next pass, which reports `result.deliveryRefusal` as the reason.
 *
 * Same `(id, status='sent', executedAt=<claim ts>)` fence as
 * `releaseClaimedCommandDelivery`, and the same context note applies.
 */
export async function expireRefusedClaimedCommandDelivery(
  commandId: string,
  executedAt: Date,
  reason: string,
): Promise<void> {
  await withSystemDbAccessContext(() =>
    db
      .update(deviceCommands)
      .set({
        status: 'pending',
        executedAt: null,
        deliverBy: new Date(),
        result: { deliveryRefusal: reason },
      })
      .where(
        and(
          eq(deviceCommands.id, commandId),
          eq(deviceCommands.status, 'sent'),
          eq(deviceCommands.executedAt, executedAt),
        ),
      ),
  );
}

/**
 * Who is claiming (#8318 §6.4): the device row the caller authenticated as,
 * the `agent_id` it authenticated with and the `install_incarnation` read
 * with it. An object, not a bare device id, so no claim site can forget the
 * caller half — a stale caller (one that authenticated under `n` after the
 * device moved to `n+1`) must never be handed a row stamped `n+1`, and one
 * whose row an in-place F3 re-enroll gave a new `agent_id` (same incarnation)
 * must never be handed the new install's rows.
 */
export interface CommandClaimCaller extends CommandCallerIncarnation {
  deviceId: string;
  agentId: string;
}

export async function claimPendingCommandsForDevice(
  caller: CommandClaimCaller,
  limit: number = 10,
  targetRole: 'agent' | 'watchdog' = 'agent',
  // #2774 — when set (offboarding drain window), only commands of these types
  // are claimable; anything else stays `pending` and is reaped/cancelled by
  // the normal lifecycle. The drain callers pass ['self_uninstall'].
  typeAllowlist?: readonly string[],
  capabilities?: {
    peripheralPolicyProtocolVersion?: number;
    rollbackProtocolVersion?: number;
    pamLifetimeProtocolVersion?: number;
    pamReconciliationResetProtocolVersion?: number;
  },
): Promise<DeviceCommandRow[]> {
  // Only HTTP delivery paths (heartbeat responses) claim batches; the agent
  // WebSocket never embeds command batches in frames (#2407 removed the
  // connect-time/heartbeat_ack claims — no agent version ever consumed them),
  // so the per-frame payload budget that #2399 added here is gone with it.
  const deviceId = caller.deviceId;
  return db.transaction(async (tx) => {
    const peripheralV2IsClaimable =
      typeAllowlist === undefined || typeAllowlist.includes('peripheral_policy_sync_v2');
    if (
      targetRole === 'agent'
      && peripheralV2IsClaimable
      && capabilities?.peripheralPolicyProtocolVersion !== 2
    ) {
      await tx
        .update(deviceCommands)
        .set({
          status: 'cancelled',
          completedAt: new Date(),
          result: { status: 'failed', error: 'peripheral_policy_protocol_v2_not_reported' },
          ...terminalPayloadErasureSet(),
        })
        .where(and(
          eq(deviceCommands.deviceId, deviceId),
          eq(deviceCommands.status, 'pending'),
          eq(deviceCommands.targetRole, 'agent'),
          eq(deviceCommands.type, 'peripheral_policy_sync_v2'),
        ));
      await tx
        .update(peripheralPolicyDeviceStates)
        .set({
          deliveryStatus: 'rejected',
          lastErrorCode: 'protocol_capability_not_reported',
          updatedAt: new Date(),
        })
        .where(and(
          eq(peripheralPolicyDeviceStates.deviceId, deviceId),
          eq(peripheralPolicyDeviceStates.deliveryStatus, 'pending'),
        ));
    }

    const unsupportedProtocolTypes: string[] = [];
    if (targetRole === 'agent' && capabilities?.peripheralPolicyProtocolVersion !== 2) {
      unsupportedProtocolTypes.push('peripheral_policy_sync_v2');
    }
    if (targetRole === 'agent' && capabilities?.rollbackProtocolVersion !== 1) {
      unsupportedProtocolTypes.push('agent_rollback_v1');
    }
    if (targetRole === 'agent' && capabilities?.pamLifetimeProtocolVersion !== 2) {
      unsupportedProtocolTypes.push('pam_apply_v2', 'pam_cleanup_v2');
    }
    // Recovery must remain deliverable while the normal PAM capability is 0,
    // but only builds implementing the evidence-preserving reset may claim it.
    if (targetRole === 'agent' && capabilities?.pamReconciliationResetProtocolVersion !== 1) {
      unsupportedProtocolTypes.push('pam_reconcile_v2');
    }

    // A device parked in a holding org is claimed under the removal allowlist
    // (agentAuth narrows it), so the scan below never sees its other rows —
    // they would sit `pending` until the reaper's clock. Cancel them here, in
    // this claim transaction, through the same claim-time eligibility that
    // terminalises and propagates every other refusal. Only on the narrowed
    // path: an unrestricted claim reaches that eligibility through the scan,
    // and a drained device in an ordinary org keeps its rows pending.
    if (typeAllowlist !== undefined) {
      const [parkedDevice] = await tx
        .select({
          id: devices.id,
          orgId: devices.orgId,
          status: devices.status,
          orgType: organizations.type,
          installIncarnation: devices.installIncarnation,
        })
        .from(devices)
        .innerJoin(organizations, eq(organizations.id, devices.orgId))
        .where(eq(devices.id, deviceId))
        .limit(1);
      if (parkedDevice && isUnassignedPoolOrgType(parkedDevice.orgType)) {
        const refused = await tx
          .select()
          .from(deviceCommands)
          .where(
            and(
              eq(deviceCommands.deviceId, deviceId),
              eq(deviceCommands.status, 'pending'),
              eq(deviceCommands.targetRole, targetRole),
              notInArray(deviceCommands.type, [...typeAllowlist]),
            ),
          )
          .orderBy(deviceCommands.createdAt)
          .limit(PARKED_REFUSED_CANCEL_BATCH)
          .for('update', { skipLocked: true });
        if (refused.length > 0) {
          await partitionClaimable(tx, parkedDevice, refused);
        }
      }
    }

    const now = new Date();
    const pendingCommands = await tx
      .select()
      .from(deviceCommands)
      .where(
        and(
          eq(deviceCommands.deviceId, deviceId),
          eq(deviceCommands.status, 'pending'),
          eq(deviceCommands.targetRole, targetRole),
          // #5128: a row past its delivery deadline is the reaper's, not ours.
          or(isNull(deviceCommands.deliverBy), gt(deviceCommands.deliverBy, now)),
          ...(typeAllowlist ? [inArray(deviceCommands.type, [...typeAllowlist])] : []),
          ...(unsupportedProtocolTypes.length > 0
            ? [notInArray(deviceCommands.type, unsupportedProtocolTypes)]
            : []),
        ),
      )
      .orderBy(deviceCommands.createdAt)
      .limit(limit)
      .for('update', { skipLocked: true });

    // #5128 §G: re-check eligibility at the moment of delivery. A queued
    // command may have been requested days ago, so the device's org, lifecycle,
    // partner trust and the requester's account are all re-evaluated here, and
    // the power-state barrier is applied. Cancels are written on `tx`, so a row
    // this rejects cannot be delivered by a concurrent claim.
    let deliverable = pendingCommands;
    if (pendingCommands.length > 0) {
      // Inner join for the org type (a holding-org device gets lifecycle
      // removal only). A device whose org this context cannot see is treated
      // like a vanished device: nothing in the batch is delivered.
      const [dev] = await tx
        .select({
          id: devices.id,
          orgId: devices.orgId,
          status: devices.status,
          orgType: organizations.type,
          installIncarnation: devices.installIncarnation,
        })
        .from(devices)
        .innerJoin(organizations, eq(organizations.id, devices.orgId))
        .where(eq(devices.id, deviceId))
        .limit(1);
      if (!dev) return [];

      const [inFlightRow] = await tx
        .select({ inFlight: sql<number>`count(*)::int` })
        .from(deviceCommands)
        .where(
          and(
            eq(deviceCommands.deviceId, deviceId),
            eq(deviceCommands.status, 'sent'),
            eq(deviceCommands.targetRole, targetRole),
          ),
        )
        .limit(1);

      // Every pending row goes through eligibility, so a row stamped for an
      // EARLIER incarnation is terminalised (superseded_by_reattach) by
      // whichever install's beat finds it — a device fact, not a caller fact.
      const { claimable } = await partitionClaimable(tx, dev, pendingCommands, {
        inFlight: inFlightRow?.inFlight ?? 0,
      });
      const claimableIds = new Set(claimable.map((c) => c.id));
      // #8318 §6.4: delivery is a CALLER fact. A row stamped for an
      // incarnation other than the one this caller authenticated under is
      // not this caller's to take: a caller that authenticated under `n`
      // after a confirm moved the device to `n+1` leaves the `n+1` rows
      // pending for the install they were enqueued for. (After the step
      // above, a surviving row's stamp is the device's current incarnation,
      // so a mismatch here means the CALLER is stale.) The flip below
      // re-checks both halves in SQL.
      deliverable = pendingCommands.filter(
        (c) => claimableIds.has(c.id) && commandStampMatchesCaller(c.deviceIncarnation, caller.installIncarnation),
      );
      if (deliverable.length === 0) return [];
    }

    const claimed: DeviceCommandRow[] = [];
    for (const command of deliverable) {
      const executedAt = new Date();
      const rows = await tx
        .update(deviceCommands)
        .set({ status: 'sent', executedAt })
        .where(
          and(
            eq(deviceCommands.id, command.id),
            eq(deviceCommands.deviceId, deviceId),
            eq(deviceCommands.status, 'pending'),
            eq(deviceCommands.targetRole, targetRole),
            // #8318: both halves re-read in the flip itself (see
            // claimInSavepoint): the stamp equals the device's CURRENT
            // incarnation AND the caller's authenticated one.
            commandIncarnationAcceptedForCallerCondition(caller),
            // #8318 §6.4: and the device still carries the agent_id the
            // caller authenticated with, read in the same statement. An
            // in-place F3 re-enroll changes `agent_id` WITHOUT advancing the
            // incarnation, so the incarnation halves cannot see it; a row of
            // a device that changed hands after auth stays `pending` for the
            // install that now owns it (same check as the push flip).
            sql`EXISTS (SELECT 1 FROM ${devices} WHERE ${devices.id} = ${deviceCommands.deviceId} AND ${devices.agentId} = ${caller.agentId})`,
          ),
        )
        .returning();
      if (rows[0]) {
        claimed.push(rows[0]);
      }
    }

    return claimed;
  });
}
