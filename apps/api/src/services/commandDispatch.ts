import { and, eq, gt, inArray, isNull, notInArray, or, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { deviceCommands, devices, organizations, peripheralPolicyDeviceStates } from '../db/schema';
import { partitionClaimable, POWER_STATE_BARRIER_TYPES } from './commandClaimEligibility';
import { terminalPayloadErasureSet } from './sensitiveCommandPayload';
import { isUnassignedPoolOrgType } from './unassignedPool/orgType';
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

export async function claimPendingCommandForDelivery(
  commandId: string,
  executedAt: Date = new Date(),
): Promise<{ id: string; executedAt: Date } | null> {
  // device_commands is system-scoped (agent WS path) and this runs from
  // executeCommand's runOutsideDbContext block — establish a system context so
  // the write isn't a contextless bare-pool write (#1375 warning flood).
  // The whole claim runs on ONE connection: the system context's transaction
  // (or the caller's own context, which withSystemDbAccessContext joins), with
  // a savepoint so `partitionClaimable` gets a real transaction handle for its
  // own savepointed resolver reads. Nothing below opens a second pooled
  // connection (#1105, #7919).
  const rows = await withSystemDbAccessContext(() => db.transaction(async (tx) => {
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
        deviceOrgId: devices.orgId,
        deviceStatus: devices.status,
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
    if (!candidate) return [];

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

    const { claimable } = await partitionClaimable(
      tx,
      {
        id: candidate.deviceId,
        orgId: candidate.deviceOrgId,
        status: candidate.deviceStatus,
        orgType: candidate.orgType,
      },
      [
        {
          id: candidate.id,
          type: candidate.type,
          createdBy: candidate.createdBy,
          submittedOrgId: candidate.submittedOrgId,
          deliverBy: candidate.deliverBy,
          payload: candidate.payload,
        },
      ],
      { inFlight },
    );
    if (!claimable.some((c) => c.id === candidate.id)) return [];

    return tx
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
        ),
      )
      .returning({ id: deviceCommands.id });
  }));

  return rows.length > 0 ? { id: commandId, executedAt } : null;
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

export async function claimPendingCommandsForDevice(
  deviceId: string,
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
  },
): Promise<DeviceCommandRow[]> {
  // Only HTTP delivery paths (heartbeat responses) claim batches; the agent
  // WebSocket never embeds command batches in frames (#2407 removed the
  // connect-time/heartbeat_ack claims — no agent version ever consumed them),
  // so the per-frame payload budget that #2399 added here is gone with it.
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

      const { claimable } = await partitionClaimable(tx, dev, pendingCommands, {
        inFlight: inFlightRow?.inFlight ?? 0,
      });
      const claimableIds = new Set(claimable.map((c) => c.id));
      deliverable = pendingCommands.filter((c) => claimableIds.has(c.id));
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
