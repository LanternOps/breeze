/**
 * Reason-scoped device-uninstall drain (#3986 Task 6).
 *
 * Three different features queue a `self_uninstall` `device_commands` row,
 * but only ONE of them — device remove — may receive drain treatment (agent
 * channel kept narrowly alive so an offline machine still collects the
 * uninstall once it reconnects):
 *
 *   - device remove (this module)          → gets the drain.
 *   - tenant offboarding (tenantOffboarding.ts) → has its own separate drain.
 *   - abuse suspension (routes/admin/abuse.ts)  → must keep expiring normally.
 *
 * `abuse.ts` selects every device under the partner with NO status filter,
 * so it queues uninstalls onto already-decommissioned devices too. A
 * predicate of the shape "decommissioned device + any pending self_uninstall"
 * would therefore sweep up abuse rows, exempt them from expiry, and on
 * un-suspension deliver a fleet-wide uninstall to a reinstated customer.
 * That is the incident this module exists to prevent — the predicate below
 * requires the explicit `device_remove` reason AND an unexpired deadline,
 * never bare presence of a pending self_uninstall.
 *
 * Multi-valued reasons, not a single `origin`: a device can be removed while
 * its tenant is ALSO offboarding, so one `device_commands` row can carry two
 * lifecycle owners at once (`uninstall_reasons @> ARRAY['device_remove',
 * 'tenant_offboarding']`). Each canceller strips only its own reason via
 * `releaseDeviceRemoveReason`, and the row is only cancelled once no
 * destructive reason remains.
 *
 * Concurrency: `queueDeviceUninstall` takes the CALLER's transaction and
 * locks the target `devices` row `FOR UPDATE` before its read-then-write on
 * `device_commands`, mirroring `tenantOffboarding.ts`'s
 * `queueDrainUninstalls`. Without that lock two concurrent Removes both
 * observe "no existing row" and insert duplicates. A unique index on
 * `device_commands` was deliberately rejected upstream (see
 * `tenantOffboarding.ts`'s comment on `queueDrainUninstalls`) because it
 * would break the abuse-suspension bulk insert — the row lock is the
 * sanctioned pattern here too.
 */

import { and, arrayContains, eq, gt, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { deviceCommands, devices } from '../db/schema';
import { terminalPayloadErasureSet } from './sensitiveCommandPayload';
import { envInt } from '../utils/envInt';

/** The type of a drizzle transaction handle, extracted the same way
 * `deviceMtlsCertificateLifecycle.ts`'s `Tx` does — lets `queueDeviceUninstall`
 * compose into a CALLER's transaction (the device-remove route will write
 * `devices.status = 'decommissioned'` and queue the uninstall atomically)
 * instead of always opening its own.
 */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The one reason value that grants the drain exemption. Every other reason
 * (`tenant_offboarding`, or none at all for abuse-queued rows) must NOT widen
 * authentication or exempt a row from normal expiry. */
export const UNINSTALL_REASON_DEVICE_REMOVE = 'device_remove' as const;

// `envInt` cannot return a non-finite number, so the old `Number.isFinite`
// arm here would be unfalsifiable; the `>= 1` floor is the part that matters.
const RAW_WINDOW_HOURS = envInt('DEVICE_UNINSTALL_DRAIN_WINDOW_HOURS', 72);
export const DEVICE_UNINSTALL_DRAIN_WINDOW_HOURS = RAW_WINDOW_HOURS >= 1 ? RAW_WINDOW_HOURS : 72;

const NON_TERMINAL_COMMAND_STATUSES = ['pending', 'sent'] as const;

/**
 * The predicate every consumer (routes, auth middleware, stale-command
 * reaper) must use — implemented here ONCE so there is exactly one place
 * that can drift out of sync with the incident guard above.
 *
 * draining(device) :=
 *       device.status = 'decommissioned'
 *   AND EXISTS (SELECT 1 FROM device_commands
 *               WHERE device_id = device.id
 *                 AND type = 'self_uninstall'
 *                 AND status IN ('pending','sent')
 *                 AND uninstall_reasons @> ARRAY['device_remove']
 *                 AND device_remove_expires_at > now())
 *
 * Implemented as an inner join (rather than a correlated EXISTS) purely for
 * readability — semantically identical, and a `LIMIT 1` keeps it cheap.
 */
export async function isDeviceUninstallDraining(deviceId: string): Promise<boolean> {
  const rows = await db
    .select({ id: deviceCommands.id })
    .from(deviceCommands)
    .innerJoin(devices, eq(deviceCommands.deviceId, devices.id))
    .where(
      and(
        eq(devices.id, deviceId),
        eq(devices.status, 'decommissioned'),
        eq(deviceCommands.type, 'self_uninstall'),
        inArray(deviceCommands.status, [...NON_TERMINAL_COMMAND_STATUSES]),
        arrayContains(deviceCommands.uninstallReasons, [UNINSTALL_REASON_DEVICE_REMOVE]),
        gt(deviceCommands.deviceRemoveExpiresAt, sql`now()`),
      ),
    )
    .limit(1);

  return rows.length > 0;
}

/**
 * Queue (or merge into) a `self_uninstall` command carrying the
 * `device_remove` reason and a `now() + DEVICE_UNINSTALL_DRAIN_WINDOW_HOURS`
 * deadline.
 *
 * Runs inside the CALLER's transaction (`tx`) — the caller is expected to be
 * mid-way through decommissioning the device in the same transaction (trap:
 * `queueCommandForExecution` in commandQueue.ts hard-fails when
 * `device.status !== 'online'`, and by the time we queue here the device is
 * already `decommissioned`, so that helper cannot be used).
 *
 * Locks the `devices` row `FOR UPDATE` first so two concurrent Removes can't
 * both observe "no existing row" and double-insert (see module doc).
 *
 * `actorUserId` is an explicit parameter, never read from request auth here
 * — services must not reach into `auth` themselves (issue #3978's failure
 * mode, `commandQueue.ts`'s `createdBy` passthrough).
 */
export async function queueDeviceUninstall(
  tx: Tx,
  deviceId: string,
  actorUserId: string | null,
): Promise<{ queued: boolean; mergedIntoExisting: boolean }> {
  const deviceRows = await tx
    .select({ id: devices.id })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .for('update');

  if (deviceRows.length === 0) {
    return { queued: false, mergedIntoExisting: false };
  }

  const existing = await tx
    .select({
      id: deviceCommands.id,
      uninstallReasons: deviceCommands.uninstallReasons,
      deviceRemoveExpiresAt: deviceCommands.deviceRemoveExpiresAt,
    })
    .from(deviceCommands)
    .where(
      and(
        eq(deviceCommands.deviceId, deviceId),
        eq(deviceCommands.type, 'self_uninstall'),
        inArray(deviceCommands.status, [...NON_TERMINAL_COMMAND_STATUSES]),
      ),
    );

  const deadline = new Date(Date.now() + DEVICE_UNINSTALL_DRAIN_WINDOW_HOURS * 60 * 60 * 1000);

  if (existing.length > 0) {
    // Another feature (tenant offboarding, or a duplicate device-remove call)
    // already has a non-terminal self_uninstall in flight for this device.
    // Stamp OUR reason onto every such row (defensive: normal operation keeps
    // this to one row via the FOR UPDATE lock, but abuse.ts's bulk insert has
    // no such lock and can leave more than one) rather than inventing a
    // second row for the same device — a fresh insert here would race the
    // in-flight one for delivery with no benefit.
    for (const row of existing) {
      const reasons = new Set(row.uninstallReasons ?? []);
      reasons.add(UNINSTALL_REASON_DEVICE_REMOVE);
      await tx
        .update(deviceCommands)
        .set({
          uninstallReasons: [...reasons],
          // Preserve an already-set deadline (idempotent retry of the same
          // device-remove call must not keep pushing the window out); only
          // stamp one if this row never had the device_remove exemption.
          deviceRemoveExpiresAt: row.deviceRemoveExpiresAt ?? deadline,
        })
        .where(eq(deviceCommands.id, row.id));
    }
    return { queued: false, mergedIntoExisting: true };
  }

  await tx.insert(deviceCommands).values({
    deviceId,
    type: 'self_uninstall',
    payload: { removeConfig: true },
    status: 'pending',
    targetRole: 'agent',
    createdBy: actorUserId,
    uninstallReasons: [UNINSTALL_REASON_DEVICE_REMOVE],
    deviceRemoveExpiresAt: deadline,
  });

  return { queued: true, mergedIntoExisting: false };
}

/**
 * Release the caller's hold on the drain exemption for `deviceId`'s
 * self_uninstall row(s): strip `device_remove` out of `uninstall_reasons`,
 * and only cancel the row once no destructive reason remains (another owner,
 * e.g. `tenant_offboarding`, may still need it delivered).
 *
 * `reason` is the human-readable value stamped into `result.reason` on an
 * actual cancellation — mirrors `tenantOffboarding.ts`'s
 * `cancelDrainUninstallsForOrgIds(orgIds, reason)`.
 *
 * A row still `sent` (already dispatched — the agent may have claimed it)
 * is never transitioned to `cancelled` here; it is reported as
 * `alreadyDispatched` instead, after still having `device_remove` stripped
 * so it stops draining. Only a `pending` row with zero reasons left after
 * the strip is cancelled, and every such cancellation includes
 * `terminalPayloadErasureSet()` like every other terminal writer in this
 * codebase.
 */
export async function releaseDeviceRemoveReason(
  deviceId: string,
  reason: string,
): Promise<{ cancelled: number; retainedOtherOwner: number; alreadyDispatched: number }> {
  return db.transaction(async (tx) => {
    const stripped = await tx
      .update(deviceCommands)
      .set({
        uninstallReasons: sql`array_remove(${deviceCommands.uninstallReasons}, ${UNINSTALL_REASON_DEVICE_REMOVE})`,
        deviceRemoveExpiresAt: sql`CASE WHEN array_remove(${deviceCommands.uninstallReasons}, ${UNINSTALL_REASON_DEVICE_REMOVE}) = '{}' THEN NULL ELSE ${deviceCommands.deviceRemoveExpiresAt} END`,
      })
      .where(
        and(
          eq(deviceCommands.deviceId, deviceId),
          eq(deviceCommands.type, 'self_uninstall'),
          inArray(deviceCommands.status, [...NON_TERMINAL_COMMAND_STATUSES]),
          arrayContains(deviceCommands.uninstallReasons, [UNINSTALL_REASON_DEVICE_REMOVE]),
        ),
      )
      .returning({
        id: deviceCommands.id,
        status: deviceCommands.status,
        uninstallReasons: deviceCommands.uninstallReasons,
      });

    let cancelled = 0;
    let retainedOtherOwner = 0;
    let alreadyDispatched = 0;
    const toCancelIds: string[] = [];

    for (const row of stripped) {
      const stillOwned = (row.uninstallReasons ?? []).length > 0;
      if (stillOwned) {
        retainedOtherOwner += 1;
        continue;
      }
      if (row.status === 'pending') {
        toCancelIds.push(row.id);
      } else {
        // 'sent' — already dispatched to the agent; do not flip it terminal
        // out from under an in-flight delivery.
        alreadyDispatched += 1;
      }
    }

    if (toCancelIds.length > 0) {
      await tx
        .update(deviceCommands)
        .set({
          status: 'cancelled',
          completedAt: new Date(),
          result: { reason },
          ...terminalPayloadErasureSet(),
        })
        .where(inArray(deviceCommands.id, toCancelIds));
      cancelled = toCancelIds.length;
    }

    return { cancelled, retainedOtherOwner, alreadyDispatched };
  });
}
