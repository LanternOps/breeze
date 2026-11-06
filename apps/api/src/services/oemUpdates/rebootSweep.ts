/**
 * Overnight reboots a scheduled vendor update run owes (#11065, spec 4.5).
 *
 * The result handler only starts the clock (`reboot_pending_since`). This sweep,
 * every tick, turns that into a `schedule_reboot` inside tonight's window through
 * `planOvernightReboot`, once a night, with `deadlineAction: 'hold'`: a restart that
 * cannot begin by the window's close is dropped by the agent, not forced, and the
 * next night tries again. After 3 nights the device reads **Reboot overdue**
 * (`deriveOemDisplayState`), and it goes on holding. Nothing here ever forces one.
 *
 * A held restart reaches the API only as `rebootStatus: null`, so nothing records
 * it. The clock stays set, which is all the next night needs.
 *
 * Uptime is what ends it: a device whose check-ins show a boot after the clock
 * started, on two ticks running, has rebooted, whoever did it. The agent's verification report and a clean
 * result end it too (`results.ts`).
 *
 * Reboots only a policy's own: the run that started the clock was scheduled, the
 * policy still runs that vendor, and it says `overnight`. A Run Now keeps the tech's
 * choice, and `never` leaves the device waiting. A shutdown request never starts the clock.
 */
import { and, desc, eq, gt, gte, inArray, isNotNull, lte } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { deviceCommands, deviceOemUpdateStatus, devices, organizations, partners, sites } from '../../db/schema';
import { executeReboot, resolveRebootPlan } from '../patchRebootHandler';
import { captureException } from '../sentry';
import { notParkedDeviceCondition } from '../unassignedPool/selectorPredicate';
import {
  effectiveTimezoneFrom,
  maintenanceAllowsRun,
  maxDispatchPerTick,
  type DeviceTimezoneFields,
} from './candidates';
import { oemRunCommandFilter } from './dispatch';
import { laneDisabledByKillSwitch, oemUpdatesEnabled } from './flags';
import { nightlyWindow } from './occurrence';
import { planOvernightReboot } from './rebootPlanner';
import { resolveOemUpdatesLinksForDevices, type ResolvedOemUpdatesLink } from './resolver';
import type { OemLane } from '@breeze/shared';

const PAGE_SIZE = 500;
const OWED_REBOOT_REASON = 'Vendor updates need a restart to finish';
/**
 * A restart already asked for tonight. `completed` is included because the agent
 * answers that as soon as it has scheduled one, and `failed` and `timeout` because
 * a refusal is tonight's one try: the next night asks again rather than every tick.
 */
const REBOOT_COMMAND_TYPES = ['reboot', 'schedule_reboot', 'reboot_safe_mode'] as const;
const ASKED_TONIGHT_STATUSES = ['pending', 'sent', 'completed', 'failed', 'timeout'] as const;
/** Two readings of the boot time this close agree. */
const BOOT_AGREEMENT_MS = 5 * 60_000;

type OwedRow = DeviceTimezoneFields & {
  deviceId: string;
  orgId: string;
  partnerId: string;
  lane: OemLane | null;
  deviceStatus: string;
  agentVersion: string | null;
  lastSeenAt: Date | null;
  uptimeSeconds: number | null;
  rebootPendingSince: Date | null;
  rebootScheduledAt: Date | null;
};

function report(error: unknown, row: Pick<OwedRow, 'deviceId' | 'orgId'>): void {
  console.error(`[OemUpdates] reboot sweep failed for device ${row.deviceId}:`, error);
  captureException(error instanceof Error ? error : new Error(String(error)), undefined, {
    worker: 'oemUpdatesWorker',
    org_id: row.orgId,
  });
}

function loadPage(after: string | null): Promise<OwedRow[]> {
  return db
    .select({
      deviceId: deviceOemUpdateStatus.deviceId,
      orgId: devices.orgId,
      partnerId: organizations.partnerId,
      lane: deviceOemUpdateStatus.lane,
      deviceStatus: devices.status,
      agentVersion: devices.agentVersion,
      lastSeenAt: devices.lastSeenAt,
      uptimeSeconds: devices.uptimeSeconds,
      rebootPendingSince: deviceOemUpdateStatus.rebootPendingSince,
      rebootScheduledAt: devices.rebootScheduledAt,
      siteTimezone: sites.timezone,
      orgSettings: organizations.settings,
      partnerTimezone: partners.timezone,
      partnerSettings: partners.settings,
    })
    .from(deviceOemUpdateStatus)
    .innerJoin(devices, eq(devices.id, deviceOemUpdateStatus.deviceId))
    .innerJoin(organizations, eq(organizations.id, devices.orgId))
    .leftJoin(partners, eq(partners.id, organizations.partnerId))
    .leftJoin(sites, eq(sites.id, devices.siteId))
    .where(and(
      isNotNull(deviceOemUpdateStatus.rebootPendingSince),
      eq(devices.isEphemeral, false),
      notParkedDeviceCondition(),
      ...(after ? [gt(deviceOemUpdateStatus.deviceId, after)] : []),
    ))
    .orderBy(deviceOemUpdateStatus.deviceId)
    .limit(PAGE_SIZE) as Promise<OwedRow[]>;
}

/**
 * The boot the last check-in implies, when it is later than when the reboot became
 * owed. `last_seen_at` minus `uptime_seconds`.
 */
function impliedBootSinceOwed(row: OwedRow): number | null {
  if (!row.rebootPendingSince || !row.lastSeenAt || row.uptimeSeconds === null) return null;
  const bootAt = row.lastSeenAt.getTime() - row.uptimeSeconds * 1000;
  return bootAt > row.rebootPendingSince.getTime() ? bootAt : null;
}

/**
 * Boot readings seen once, waiting for a second tick to agree. A socket that reopens
 * writes `last_seen_at` before the first heartbeat writes a fresh uptime, so for a
 * moment a device that only slept reads as having booted since. The next heartbeat
 * moves the reading back; a real reboot reads the same on the next tick. In memory:
 * a restart costs one more tick, never a false clear.
 */
const bootSightings = new Map<string, number>();

export function resetOemRebootSightingsForTests(): void {
  bootSightings.clear();
}

type BootEvidence = 'none' | 'first_sighting' | 'confirmed';

function bootEvidence(row: OwedRow): BootEvidence {
  const bootAt = impliedBootSinceOwed(row);
  if (bootAt === null) {
    bootSightings.delete(row.deviceId);
    return 'none';
  }
  const seen = bootSightings.get(row.deviceId);
  if (seen !== undefined && Math.abs(seen - bootAt) <= BOOT_AGREEMENT_MS) {
    bootSightings.delete(row.deviceId);
    return 'confirmed';
  }
  bootSightings.set(row.deviceId, bootAt);
  return 'first_sighting';
}

function mayReboot(row: OwedRow): row is OwedRow & { lane: OemLane } {
  if (!row.lane) return false;
  if (!oemUpdatesEnabled(row.partnerId) || laneDisabledByKillSwitch(row.lane)) return false;
  // Nothing sent now would reach it inside the window, and a late one is refused anyway.
  if (row.deviceStatus !== 'online') return false;
  // The agent already has a restart coming, and the next Schedule would replace it.
  return !row.rebootScheduledAt;
}

/**
 * Whether the run that started the clock was a scheduled one: the newest run queued
 * at or before it. Not the device's latest run, since a Run Now after a scheduled
 * flash would otherwise take the flash's reboot with it. A Run Now's own reboot is
 * the tech's, and an unreadable payload is not consent.
 */
async function owedByScheduledRun(row: OwedRow): Promise<boolean> {
  const [run] = await withSystemDbAccessContext(() => db
    .select({ payload: deviceCommands.payload })
    .from(deviceCommands)
    .where(and(
      eq(deviceCommands.deviceId, row.deviceId),
      oemRunCommandFilter(),
      lte(deviceCommands.createdAt, row.rebootPendingSince!),
    ))
    .orderBy(desc(deviceCommands.createdAt))
    .limit(1));
  return (run?.payload as { trigger?: unknown } | null | undefined)?.trigger === 'scheduled';
}

async function clearReboot(row: OwedRow, now: Date): Promise<void> {
  await withSystemDbAccessContext(() => db
    .update(deviceOemUpdateStatus)
    .set({ rebootRequired: false, rebootPendingSince: null, updatedAt: now })
    // The clock it was decided on: a run reporting since has started its own.
    .where(and(
      eq(deviceOemUpdateStatus.deviceId, row.deviceId),
      eq(deviceOemUpdateStatus.rebootPendingSince, row.rebootPendingSince!),
    )));
}

async function rebootAskedForSince(deviceId: string, since: Date): Promise<boolean> {
  const rows = await withSystemDbAccessContext(() => db
    .select({ commandId: deviceCommands.id })
    .from(deviceCommands)
    .where(and(
      eq(deviceCommands.deviceId, deviceId),
      inArray(deviceCommands.type, [...REBOOT_COMMAND_TYPES]),
      inArray(deviceCommands.status, [...ASKED_TONIGHT_STATUSES]),
      gte(deviceCommands.createdAt, since),
    ))
    .limit(1));
  return rows.length > 0;
}

/** True when a restart was queued. */
async function rebootTonight(row: OwedRow & { lane: OemLane }, link: ResolvedOemUpdatesLink | null, now: Date): Promise<boolean> {
  if (!link || link.invalidStoredSettings || !link.settings.enabled) return false;
  if (!link.settings.vendors[row.lane]?.enabled) return false;
  // Under `never` the device waits for someone else's restart.
  if (link.settings.reboot !== 'overnight') return false;

  const timezone = effectiveTimezoneFrom(row);
  const { windowStart, windowEnd } = nightlyWindow(link.settings.schedule, timezone, now);
  if (now.getTime() < windowStart.getTime()) return false;

  if (!await owedByScheduledRun(row)) return false;
  if (await rebootAskedForSince(row.deviceId, windowStart)) return false;
  if (!await maintenanceAllowsRun(row.deviceId, row.orgId, now)) return false;

  const { delayMinutes, deferral, promptText } = await withSystemDbAccessContext(() => resolveRebootPlan(row.deviceId));
  const plan = planOvernightReboot({
    now,
    windowStart,
    windowEnd,
    timezone,
    patchDelayMinutes: delayMinutes,
    deferral,
    agentVersion: row.agentVersion,
  });
  // Held: no write. The clock stays set, and the next night's first tick asks again.
  if (plan.action === 'hold') return false;

  const queued = await executeReboot(row.deviceId, OWED_REBOOT_REASON, {
    delayMinutes: plan.delayMinutes,
    deferral: plan.deferral,
    promptText,
    windowEndsAt: plan.windowEndsAt,
    deadlineAction: plan.deadlineAction,
    expectedOrgId: row.orgId,
    source: 'oem_updates',
    commitBeforeDelivery: true,
  });
  if (!queued.success) {
    report(new Error(queued.error ?? 'schedule_reboot was refused'), row);
    return false;
  }
  return true;
}

export async function runOemRebootSweep(now: Date): Promise<void> {
  let remaining = maxDispatchPerTick();
  let queued = 0;
  let cleared = 0;
  let after: string | null = null;
  for (;;) {
    const cursor: string | null = after;
    const page: OwedRow[] = await withSystemDbAccessContext(() => loadPage(cursor));

    const stillOwed: OwedRow[] = [];
    for (const row of page) {
      const evidence = bootEvidence(row);
      if (evidence === 'none') {
        stillOwed.push(row);
        continue;
      }
      // Seen once: neither cleared nor rebooted again until the next tick agrees.
      if (evidence === 'first_sighting') continue;
      try {
        await clearReboot(row, now);
        cleared += 1;
      } catch (error) {
        report(error, row);
      }
    }

    const eligible = stillOwed.filter(mayReboot);
    if (eligible.length > 0 && remaining > 0) {
      const links = await withSystemDbAccessContext(() =>
        resolveOemUpdatesLinksForDevices(eligible.map((row) => row.deviceId)));
      for (const row of eligible) {
        if (remaining <= 0) break;
        // One device's failure must not strand the rest. Its clock is unchanged, so
        // the next tick picks it up again.
        try {
          if (await rebootTonight(row, links.get(row.deviceId) ?? null, now)) {
            remaining -= 1;
            queued += 1;
          }
        } catch (error) {
          report(error, row);
        }
      }
    }

    if (page.length < PAGE_SIZE) break;
    after = page[page.length - 1]!.deviceId;
  }
  if (queued > 0 || cleared > 0) console.log('[OemUpdates] reboot sweep', { queued, cleared });
}
