/**
 * Hands a vendor tool's own schedule back when a device stops resolving to an
 * enabled lane (#11065, spec 4.2). Without it, removing a policy would silently stop
 * updates on a machine that used to update itself.
 *
 * Decided on the policy alone, and deliberately not on the flag or a kill switch:
 * those stop new runs for a while, and handing every schedule back during a bad-update
 * incident would start the vendor's own tool on the machines that were just paused.
 * Settings that no longer parse are not a decision either, so they release nothing.
 *
 *   taken_over + no enabled lane  → queue one release → releasing
 *   releasing + release in flight → wait (the ack clears it: `applyOemUpdateRelease`)
 *   releasing + lane back         → cancel the queued release → taken_over
 *   releasing + nothing in flight → taken_over, and the path above retries
 *
 * **Retry cap:** {@link OEM_RELEASE_MAX_ATTEMPTS} delivered releases that left the
 * takeover standing, at least
 * {@link OEM_RELEASE_RETRY_SPACING_MS} apart. Then it stops, marks the row's `reason`
 * and reports once. The device keeps its takeover, so nothing is lost and nothing
 * runs: a later scheduled run clears the marker. A queued release that expired without
 * being delivered is not an attempt, so a device offline for a month keeps its turn.
 *
 * Counted from `device_commands`, since the run after which the count restarts is
 * on the row: no new column.
 */
import { and, desc, eq, gt, inArray, isNotNull, ne } from 'drizzle-orm';
import type { OemLane } from '@breeze/shared';
import { db, withSystemDbAccessContext } from '../../db';
import { deviceCommands, deviceOemUpdateStatus, devices } from '../../db/schema';
import type { OemTakeoverState } from '../../db/schema';
import { captureException } from '../sentry';
import { notParkedDeviceCondition } from '../unassignedPool/selectorPredicate';
import {
  cancelPendingOemUpdateRelease,
  dispatchOemUpdateRelease,
  oemReleaseCommandFilter,
} from './dispatch';
import { maxDispatchPerTick } from './candidates';
import { resolveOemUpdatesLinksForDevices, type ResolvedOemUpdatesLink } from './resolver';

export const OEM_RELEASE_MAX_ATTEMPTS = 3;
export const OEM_RELEASE_RETRY_SPACING_MS = 24 * 60 * 60 * 1000;
export const OEM_RELEASE_GAVE_UP = 'release_gave_up';

const PAGE_SIZE = 500;
const HISTORY_LIMIT = 10;
/**
 * A delivered release that is still taken over afterwards did not work. `completed`
 * is here too: a successful ack clears the state in the same transaction, so a
 * completed release with the takeover still standing is one whose answer did not parse.
 */
const DELIVERED_STATUSES: ReadonlySet<string> = new Set(['failed', 'timeout', 'completed']);

type TakeoverRow = {
  deviceId: string;
  orgId: string;
  lane: OemLane;
  takeoverState: OemTakeoverState;
  reason: string | null;
  lastAttemptAt: Date | null;
};

type ReleaseHistoryRow = { commandStatus: string; createdAt: Date; executedAt: Date | null };

function report(error: unknown, row: Pick<TakeoverRow, 'deviceId' | 'orgId'>): void {
  console.error(`[OemUpdates] release sweep failed for device ${row.deviceId}:`, error);
  captureException(error instanceof Error ? error : new Error(String(error)), undefined, {
    worker: 'oemUpdatesWorker',
    org_id: row.orgId,
  });
}

function loadPage(after: string | null): Promise<TakeoverRow[]> {
  return db
    .select({
      deviceId: deviceOemUpdateStatus.deviceId,
      orgId: devices.orgId,
      lane: deviceOemUpdateStatus.lane,
      takeoverState: deviceOemUpdateStatus.takeoverState,
      reason: deviceOemUpdateStatus.reason,
      lastAttemptAt: deviceOemUpdateStatus.lastAttemptAt,
    })
    .from(deviceOemUpdateStatus)
    .innerJoin(devices, eq(devices.id, deviceOemUpdateStatus.deviceId))
    .where(and(
      inArray(deviceOemUpdateStatus.takeoverState, ['taken_over', 'releasing']),
      isNotNull(deviceOemUpdateStatus.lane),
      eq(devices.isEphemeral, false),
      ne(devices.status, 'decommissioned'),
      notParkedDeviceCondition(),
      ...(after ? [gt(deviceOemUpdateStatus.deviceId, after)] : []),
    ))
    .orderBy(deviceOemUpdateStatus.deviceId)
    .limit(PAGE_SIZE) as Promise<TakeoverRow[]>;
}

/** Newest first. */
function loadHistory(deviceId: string): Promise<ReleaseHistoryRow[]> {
  return withSystemDbAccessContext(() => db
    .select({
      commandStatus: deviceCommands.status,
      createdAt: deviceCommands.createdAt,
      executedAt: deviceCommands.executedAt,
    })
    .from(deviceCommands)
    .where(and(eq(deviceCommands.deviceId, deviceId), oemReleaseCommandFilter()))
    .orderBy(desc(deviceCommands.createdAt))
    .limit(HISTORY_LIMIT)) as Promise<ReleaseHistoryRow[]>;
}

/** Compare-and-set: an ack that landed since this row was read wins. */
async function moveState(row: TakeoverRow, to: OemTakeoverState, now: Date, extra: { reason?: string } = {}): Promise<void> {
  await withSystemDbAccessContext(() => db
    .update(deviceOemUpdateStatus)
    .set({ takeoverState: to, updatedAt: now, ...extra })
    .where(and(
      eq(deviceOemUpdateStatus.deviceId, row.deviceId),
      eq(deviceOemUpdateStatus.takeoverState, row.takeoverState),
    )));
}

/**
 * Delivered releases since the device's last run. A run is the only thing that takes
 * a schedule over, so it starts a new count; and every one of them, since the row is
 * still taken over, is one that did not hand it back.
 */
function failuresOf(row: TakeoverRow, history: ReleaseHistoryRow[]): ReleaseHistoryRow[] {
  const failures: ReleaseHistoryRow[] = [];
  for (const entry of history) {
    if (row.lastAttemptAt && entry.createdAt.getTime() <= row.lastAttemptAt.getTime()) break;
    if (DELIVERED_STATUSES.has(entry.commandStatus) && entry.executedAt) failures.push(entry);
  }
  return failures;
}

function inFlight(history: ReleaseHistoryRow[]): ReleaseHistoryRow | undefined {
  return history.find((entry) => entry.commandStatus === 'pending' || entry.commandStatus === 'sent');
}

async function keepTakeover(row: TakeoverRow, now: Date): Promise<void> {
  if (row.takeoverState !== 'releasing') return;
  const current = inFlight(await loadHistory(row.deviceId));
  if (current?.commandStatus === 'sent') return; // Running: its ack decides.
  if (current?.commandStatus === 'pending') {
    const cancelled = await withSystemDbAccessContext(() => cancelPendingOemUpdateRelease(row.deviceId, now));
    if (!cancelled) return; // Claimed in between: its ack decides.
  }
  await moveState(row, 'taken_over', now);
}

/** True when a release was queued. */
async function release(row: TakeoverRow, now: Date): Promise<boolean> {
  const history = await loadHistory(row.deviceId);
  if (inFlight(history)) {
    if (row.takeoverState !== 'releasing') await moveState(row, 'releasing', now);
    return false;
  }

  const failures = failuresOf(row, history);
  if (failures.length >= OEM_RELEASE_MAX_ATTEMPTS) {
    if (row.reason !== OEM_RELEASE_GAVE_UP) {
      await moveState(row, 'taken_over', now, { reason: OEM_RELEASE_GAVE_UP });
      report(new Error(`oem_updates release gave up after ${failures.length} failed attempts`), row);
    } else if (row.takeoverState === 'releasing') {
      await moveState(row, 'taken_over', now);
    }
    return false;
  }
  const lastFailure = failures[0];
  if (lastFailure && now.getTime() - lastFailure.createdAt.getTime() < OEM_RELEASE_RETRY_SPACING_MS) {
    if (row.takeoverState === 'releasing') await moveState(row, 'taken_over', now);
    return false;
  }

  const outcome = await dispatchOemUpdateRelease({
    deviceId: row.deviceId,
    // The device's org as read now: a device moved since its takeover is released by its new owner.
    expectedOrgId: row.orgId,
    lane: row.lane,
    actorUserId: null,
  });
  // Any other refusal leaves the row as it is, and the next tick asks again.
  if ((outcome.ok || outcome.refusal === 'release_in_flight') && row.takeoverState !== 'releasing') {
    await moveState(row, 'releasing', now);
  }
  return outcome.ok;
}

/** True when a release was queued. */
async function sweepRow(row: TakeoverRow, link: ResolvedOemUpdatesLink | null, now: Date): Promise<boolean> {
  if (link?.invalidStoredSettings) return false;
  const laneStillEnabled = link?.settings.enabled === true && link.settings.vendors[row.lane]?.enabled === true;
  if (laneStillEnabled) {
    await keepTakeover(row, now);
    return false;
  }
  return release(row, now);
}

/**
 * Releases are capped per tick like runs and reboots: a removed partner-wide policy
 * would otherwise queue one per device in a single tick. The rest go on later ticks,
 * which reach them because a queued one turns its row to `releasing`.
 */
export async function runOemReleaseSweep(now: Date): Promise<void> {
  let remaining = maxDispatchPerTick();
  let after: string | null = null;
  for (;;) {
    const cursor: string | null = after;
    const page: TakeoverRow[] = await withSystemDbAccessContext(() => loadPage(cursor));
    if (page.length === 0) return;

    const links = await withSystemDbAccessContext(() =>
      resolveOemUpdatesLinksForDevices(page.map((row) => row.deviceId)));
    for (const row of page) {
      if (remaining <= 0) break;
      // One device's failure must not strand the rest. Its state is unchanged, so
      // the next tick picks it up again.
      try {
        if (await sweepRow(row, links.get(row.deviceId) ?? null, now)) remaining -= 1;
      } catch (error) {
        report(error, row);
      }
    }

    if (remaining <= 0 || page.length < PAGE_SIZE) break;
    after = page[page.length - 1]!.deviceId;
  }
  const queued = maxDispatchPerTick() - remaining;
  if (queued > 0) console.log('[OemUpdates] release sweep', { queued });
}
