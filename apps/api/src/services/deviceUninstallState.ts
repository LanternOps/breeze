/**
 * Read-side companion to `deviceUninstallDrain.ts` (#3987 item 7).
 *
 * A Remove with "uninstall the agent" queues a durable `self_uninstall`
 * `device_commands` row and then disconnects the socket; whether the endpoint
 * actually came off is decided minutes-to-days later, by an agent that may be
 * powered down. Until this module existed, the console had no answer at all to
 * "did the agent actually go away?" — the device just sat there as Removed.
 *
 * Two things this deliberately does NOT do:
 *
 *  - It does not authorise anything. `device_commands` is intentionally
 *    system-scoped (no RLS — the agent WS path writes it), so a caller that
 *    passed a device id straight from the request into here would read a row
 *    for ANY device in the fleet. Every caller MUST have already run
 *    `getDeviceWithOrgAndSiteCheck` (or an equivalent chokepoint) on the id.
 *
 *  - It does not report bare presence of a pending `self_uninstall`. Tenant
 *    offboarding and abuse suspension queue their own rows against the same
 *    device (see `deviceUninstallDrain.ts`'s module doc for the incident that
 *    predicate shape caused), and neither is "this device's Remove". Only a
 *    row carrying the explicit `device_remove` reason is reported here — the
 *    same provenance stamp the drain exemption is keyed on.
 */

import { and, arrayContains, desc, eq } from 'drizzle-orm';
import { db } from '../db';
import { deviceCommands } from '../db/schema';
import { UNINSTALL_REASON_DEVICE_REMOVE } from './deviceUninstallDrain';

export type DeviceUninstallState =
  | 'pending'
  | 'sent'
  | 'completed'
  | 'expired'
  | 'failed'
  | 'cancelled';

export interface DeviceUninstallStatus {
  /**
   * NOTE on `sent`: it means the command was dispatched and acked by the
   * agent's command handler, NOT that the uninstall is confirmed torn down
   * (`core.ts`'s restore doc makes the same point about `alreadyDispatched`).
   * The web copy for this state says "delivered" for exactly that reason —
   * never "uninstalled". `completed` is the only state that claims teardown.
   */
  state: DeviceUninstallState;
  /** When the Remove queued it. ISO. */
  queuedAt: string;
  /** `executed_at` — when the agent was handed the command. */
  sentAt: string | null;
  completedAt: string | null;
  /** `device_remove_expires_at` — the end of the drain window, after which the
   * reaper expires the command and the agent can never collect it. */
  expiresAt: string | null;
}

/**
 * The newest `self_uninstall` row for `deviceId` carrying the `device_remove`
 * reason, mapped to a state the console can render — or `null` when this
 * device's Remove never queued one (the "leave the agent installed" choice).
 *
 * Newest-first because a restore-then-remove cycle legitimately leaves an
 * older cancelled row behind; the operator is asking about the CURRENT
 * uninstall, not the one they cancelled last week.
 *
 * **The caller MUST have authorised `deviceId` already** — see the module doc.
 */
export async function getDeviceUninstallStatus(
  deviceId: string,
): Promise<DeviceUninstallStatus | null> {
  const [row] = await db
    .select({
      status: deviceCommands.status,
      createdAt: deviceCommands.createdAt,
      executedAt: deviceCommands.executedAt,
      completedAt: deviceCommands.completedAt,
      result: deviceCommands.result,
      expiresAt: deviceCommands.deviceRemoveExpiresAt,
    })
    .from(deviceCommands)
    .where(
      and(
        eq(deviceCommands.deviceId, deviceId),
        eq(deviceCommands.type, 'self_uninstall'),
        arrayContains(deviceCommands.uninstallReasons, [UNINSTALL_REASON_DEVICE_REMOVE]),
      ),
    )
    .orderBy(desc(deviceCommands.createdAt))
    .limit(1);

  if (!row) return null;

  // `staleCommandReaper.ts` lands a drain-window expiry as status 'failed'
  // with `result.status = 'timeout'`. Surfacing that as a plain failure would
  // read as "the uninstaller ran and errored"; it is the opposite — the agent
  // never came back at all, so the endpoint is very likely still installed.
  const timedOut =
    row.status === 'failed' && (row.result as { status?: string } | null)?.status === 'timeout';

  // `device_commands.status` is an unconstrained varchar, so the union stays
  // closed here: anything unrecognised degrades to `failed` (the reading that
  // does NOT claim the agent came off) rather than being passed through to a
  // UI that would render it as a missing translation key.
  const state: DeviceUninstallState = timedOut
    ? 'expired'
    : row.status === 'pending'
      || row.status === 'sent'
      || row.status === 'completed'
      || row.status === 'cancelled'
      ? row.status
      : 'failed';

  return {
    state,
    queuedAt: row.createdAt.toISOString(),
    sentAt: row.executedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
  };
}
