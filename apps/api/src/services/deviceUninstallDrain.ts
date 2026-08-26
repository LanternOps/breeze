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

/** Tenant offboarding's ownership stamp (`tenantOffboarding.ts`) — the other
 * reason value that can co-occupy `uninstall_reasons` on the same row when a
 * device is individually removed while its tenant is ALSO offboarding.
 * Exported from here (alongside `UNINSTALL_REASON_DEVICE_REMOVE`) so both
 * owners share one constant instead of each repeating a string literal. It
 * grants NO drain exemption of its own here — `isDeviceUninstallDraining`
 * above still requires `device_remove` specifically — tenant offboarding's
 * drain is a wholly separate mechanism keyed on `organizations.status` /
 * `partners.status` (`staleCommandReaper.ts`'s first EXISTS arm), not on
 * this reason value. */
export const UNINSTALL_REASON_TENANT_OFFBOARDING = 'tenant_offboarding' as const;

// `envInt` cannot return a non-finite number, so the old `Number.isFinite`
// arm here would be unfalsifiable; the `Math.max(..., 1)` floor is the part
// that matters. NOTE: this is a genuine FLOOR, not a fallback-to-default — an
// operator setting `0` (or a negative value) gets clamped up to `1`, not
// silently reset to `72`. A ternary here (`RAW >= 1 ? RAW : 72`) would look
// almost identical but do the wrong thing: it resets an explicit `0` back to
// the 72h default instead of flooring it, which is the opposite of what an
// operator asking for the shortest possible window wants.
const RAW_WINDOW_HOURS = envInt('DEVICE_UNINSTALL_DRAIN_WINDOW_HOURS', 72);
export const DEVICE_UNINSTALL_DRAIN_WINDOW_HOURS = Math.max(RAW_WINDOW_HOURS, 1);

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
        // `pending` ONLY — deliberately NARROWER than
        // NON_TERMINAL_COMMAND_STATUSES. `claimPendingCommandsForDevice`
        // claims `pending` rows and nothing else, so a `sent` row is not a
        // row this Remove can rely on for delivery: merging into one would
        // open a fresh 72h authenticated window around a command the agent
        // can never be handed again (the previous dispatch may have been
        // lost, e.g. a restore-then-remove cycle across a socket drop).
        // Insert a new `pending` row instead — the drain exists to make the
        // uninstall COLLECTABLE, and only a pending row is. Distinct from
        // #3995, which is about the agent-side teardown fence on a row that
        // genuinely was received.
        eq(deviceCommands.status, 'pending'),
      ),
    );

  const deadline = new Date(Date.now() + DEVICE_UNINSTALL_DRAIN_WINDOW_HOURS * 60 * 60 * 1000);

  if (existing.length > 0) {
    // Another feature (tenant offboarding, or a duplicate device-remove call)
    // already has a PENDING self_uninstall in flight for this device.
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
 *
 * Takes the CALLER's transaction, mirroring `queueDeviceUninstall`'s `tx`
 * parameter — this is not incidental symmetry. #3986 task 8 fix round 1: the
 * restore route runs this release and the `devices.status` flip inside ONE
 * transaction. THE SAFETY PROPERTY IS THE SHARED TRANSACTION, not which
 * statement runs first: under READ COMMITTED, no other session can observe
 * either write until both commit together, so "status flipped, uninstall
 * still pending" never exists as a committed fact regardless of order. Two
 * separate round-trips (this used to open its own `db.transaction`) broke
 * that guarantee — a concurrent session could then observe the flip
 * committed while the release hadn't happened yet.
 *
 * `isDeviceUninstallDraining` requires `status = 'decommissioned'`; once
 * status is anything else a heartbeat can claim a still-`pending`
 * self_uninstall as an ordinary command with no type allowlist, so this is
 * what the shared transaction guards against. The caller additionally
 * orders its two writes release-before-flip as deliberate secondary
 * defense: if a future refactor ever splits the transaction back apart,
 * that order leaves the safe failure mode (device stays decommissioned,
 * uninstall already cancelled) rather than the device-wiping one.
 */
export async function releaseDeviceRemoveReason(
  tx: Tx,
  deviceId: string,
  reason: string,
): Promise<{ cancelled: number; retainedOtherOwner: number; alreadyDispatched: number }> {
  const stripped = await tx
    .update(deviceCommands)
    .set({
      uninstallReasons: sql`array_remove(${deviceCommands.uninstallReasons}, ${UNINSTALL_REASON_DEVICE_REMOVE})`,
      // The deadline is device_remove's PROPERTY, not the row's: both readers
      // (`isDeviceUninstallDraining` above and `staleCommandReaper`'s
      // exemption arm) only ever consult it alongside the `device_remove`
      // reason. So releasing that reason must release the deadline with it —
      // keyed on the reason's PRESENCE, not on the row becoming reason-LESS.
      //
      // The earlier `array_remove(...) = '{}'` form cleared it only when NO
      // owner at all remained, so a CO-OWNED row (device removed while its
      // tenant is offboarding) kept a live deadline through a restore. A
      // second Remove then took the `row.deviceRemoveExpiresAt ?? deadline`
      // preserve branch in `queueDeviceUninstall`, inherited that STALE
      // deadline, and — once it had passed — produced a device that
      // `agentAuth` hard-403s while the API and the audit log both report
      // `uninstallQueued: true`: an uninstall that can NEVER be delivered.
      // Before expiry the same bug silently SHORTENS the second window.
      deviceRemoveExpiresAt: sql`CASE WHEN ${arrayContains(deviceCommands.uninstallReasons, [UNINSTALL_REASON_DEVICE_REMOVE])} THEN NULL ELSE ${deviceCommands.deviceRemoveExpiresAt} END`,
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
}
