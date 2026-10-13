/**
 * "Logs not arriving" read-time check (#8612, W05 of #8607).
 *
 * After an operator raises a device's shipped log level to debug/info, a
 * W03+ agent emits exactly one canary `Info` line ("log shipping level
 * raised") at the raised level. If, five minutes after the raise completed,
 * not a single `agent_logs` row has arrived for the device since the command
 * was created, the console says so — observationally. It is never a fault
 * verdict and gates nothing.
 *
 * Deliberately conservative: every ambiguous input reads as `null` (show
 * nothing). In particular:
 *  - agents that never reported `logShipping` (stored state NULL) predate the
 *    canary, so silence from them proves nothing;
 *  - results without `expiresAt` predate #7416;
 *  - warn/error raises and re-statements of the base level emit no canary
 *    (`handleSetLogLevel` only logs when `appliedLevel` is more verbose than
 *    `baseLevel`).
 *
 * The probe bound is the command's `created_at`, NOT `completed_at`: the
 * canary ships before the API records completion, so comparing against
 * `completed_at` would miss it and false-alarm. The 5-minute grace runs from
 * `completed_at`. `devices.last_log_at` is never used — it is throttled to 5
 * minutes of drift and would false-alarm inside the window (Review Focus 7).
 *
 * **Authorisation:** `device_commands` is intentionally system-scoped (no
 * RLS). The caller MUST have authorised `deviceId` (e.g. via
 * `getDeviceWithOrgAndSiteCheck`) before calling this. `agent_logs` IS
 * RLS-scoped, so this must run inside the caller's request DB context.
 */

import { and, desc, eq, gte, isNotNull } from 'drizzle-orm';
import { db } from '../db';
import { agentLogs, deviceCommands } from '../db/schema';
import { CommandTypes } from './commandTypes';

/** How long after a raise completes before silence is reported. */
export const LOGS_NOT_ARRIVING_GRACE_MS = 5 * 60 * 1000;

const LEVEL_RANK: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Levels at which the canary `Info` line ships. */
const CANARY_LEVELS = new Set(['debug', 'info']);

export interface LogsNotArrivingDevice {
  /** `devices.log_shipping_state` — NULL means the agent never reported `logShipping`. */
  logShippingState: string | null;
}

export async function logsNotArriving(
  deviceId: string,
  now: Date,
  device: LogsNotArrivingDevice,
): Promise<{ raisedAt: string } | null> {
  if (device.logShippingState == null) return null;

  const [cmd] = await db
    .select({
      status: deviceCommands.status,
      createdAt: deviceCommands.createdAt,
      completedAt: deviceCommands.completedAt,
      result: deviceCommands.result,
    })
    .from(deviceCommands)
    .where(
      and(
        eq(deviceCommands.deviceId, deviceId),
        eq(deviceCommands.type, CommandTypes.SET_LOG_LEVEL),
        isNotNull(deviceCommands.completedAt),
      ),
    )
    .orderBy(desc(deviceCommands.completedAt))
    .limit(1);

  if (!cmd || cmd.status !== 'completed' || !cmd.completedAt) return null;
  if (now.getTime() - cmd.completedAt.getTime() < LOGS_NOT_ARRIVING_GRACE_MS) return null;

  const stdout = (cmd.result as { stdout?: unknown } | null)?.stdout;
  let reported: Record<string, unknown>;
  try {
    reported = JSON.parse(typeof stdout === 'string' && stdout ? stdout : '{}');
  } catch {
    return null;
  }
  if (!reported || typeof reported !== 'object') return null;

  const { appliedLevel, baseLevel, expiresAt } = reported;
  if (typeof appliedLevel !== 'string' || !CANARY_LEVELS.has(appliedLevel)) return null;
  // Canary-capable agents always report baseLevel; the canary only fires on
  // a real raise (applied more verbose than base).
  if (typeof baseLevel !== 'string' || !(baseLevel in LEVEL_RANK)) return null;
  if (LEVEL_RANK[appliedLevel]! >= LEVEL_RANK[baseLevel]!) return null;
  if (typeof expiresAt !== 'string') return null;
  const expiresMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresMs) || expiresMs <= now.getTime()) return null;

  // EXISTS probe, served by agent_logs_device_created_at_idx
  // (device_id, created_at DESC, id DESC).
  const [anyLog] = await db
    .select({ id: agentLogs.id })
    .from(agentLogs)
    .where(and(eq(agentLogs.deviceId, deviceId), gte(agentLogs.createdAt, cmd.createdAt)))
    .limit(1);
  if (anyLog) return null;

  return { raisedAt: cmd.completedAt.toISOString() };
}
