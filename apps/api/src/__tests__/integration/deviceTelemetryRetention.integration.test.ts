/**
 * #4342 W1 (#11588) — device telemetry retention guards against real Postgres,
 * through the unprivileged `breeze_app` pool (forced RLS): a batch that forgot
 * to elect system scope matches zero rows here and fails these tests.
 *
 * Every job is loaded with its `_ENFORCE=true` (set before import, hoisted), so
 * the enforce path deletes. The report path is the same run with
 * `forceReport: true`, which must delete nothing and count exactly the rows the
 * enforcing run then removes (one predicate, two modes).
 */
import { vi } from 'vitest';

vi.hoisted(() => {
  process.env.DEVICE_COMMAND_RETENTION_ENFORCE = 'true';
  process.env.FILESYSTEM_SNAPSHOT_RETENTION_ENFORCE = 'true';
  process.env.NETWORK_MONITOR_RESULT_RETENTION_ENFORCE = 'true';
  process.env.DEVICE_SESSION_RETENTION_ENFORCE = 'true';
});

import './setup';

import { beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

import { withSystemDbAccessContext } from '../../db';
import {
  deviceCommands,
  deviceFilesystemSnapshots,
  deviceSessions,
  networkMonitorResults,
  networkMonitors,
} from '../../db/schema';
import { runDeviceCommandRetention, __testOnly as commandKnobs } from '../../jobs/deviceCommandRetention';
import { runDeviceSessionRetention } from '../../jobs/deviceSessionRetention';
import { runFilesystemSnapshotRetention } from '../../jobs/filesystemSnapshotRetention';
import { runNetworkMonitorResultRetention } from '../../jobs/networkMonitorResultRetention';
import type { RetentionTargetResult } from '../../jobs/retentionTarget';
import { getDeviceUninstallStatus } from '../../services/deviceUninstallState';
import { createDevice, createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const HOUR_MS = 60 * 60 * 1000;
const daysAgo = (d: number) => new Date(NOW - d * DAY_MS);
/** One hour either side of a `days`-day cutoff: the strict `<` and the UTC wall-time compare. */
const justPast = (days: number) => new Date(NOW - days * DAY_MS - HOUR_MS);
const justInside = (days: number) => new Date(NOW - days * DAY_MS + HOUR_MS);
const KNOBS = { batchSize: 2, maxBatches: 50 };

type CommandSeed = {
  type: string;
  status: string;
  createdAt: Date;
  completedAt?: Date | null;
  uninstallReasons?: string[] | null;
  deviceId?: string;
};

function eligible(r: RetentionTargetResult): number {
  if (r.mode !== 'report') throw new Error(`expected a report run, got ${r.mode}`);
  return r.eligible;
}
function affected(r: RetentionTargetResult): number {
  if (r.mode !== 'enforce') throw new Error(`expected an enforce run, got ${r.mode}`);
  return r.affected;
}

describe('device telemetry retention (#4342 W1, real Postgres)', () => {
  let orgId: string;
  let deviceId: string;
  let otherDeviceId: string;

  beforeEach(async () => {
    const partner = await createPartner();
    orgId = (await createOrganization({ partnerId: partner.id, name: 'Retention Org' })).id;
    const site = await createSite({ orgId });
    deviceId = (await createDevice({ orgId, siteId: site.id })).id;
    otherDeviceId = (await createDevice({ orgId, siteId: site.id })).id;
  });

  async function command(seed: CommandSeed): Promise<string> {
    const [row] = await getTestDb().insert(deviceCommands).values({
      deviceId: seed.deviceId ?? deviceId,
      type: seed.type,
      status: seed.status,
      createdAt: seed.createdAt,
      completedAt: seed.completedAt === undefined ? seed.createdAt : seed.completedAt,
      uninstallReasons: seed.uninstallReasons ?? null,
    }).returning({ id: deviceCommands.id });
    return row!.id;
  }

  async function surviving(ids: string[]): Promise<Set<string>> {
    const rows = await getTestDb().select({ id: deviceCommands.id }).from(deviceCommands).where(inArray(deviceCommands.id, ids));
    return new Set(rows.map((r) => r.id));
  }

  describe('device_commands', () => {
    it('deletes old terminal rows, never non-terminal ones, and keeps each reader\'s newest row', async () => {
      const ids = {
        oldCompleted: await command({ type: 'script', status: 'completed', createdAt: daysAgo(200) }),
        oldCancelled: await command({ type: 'script', status: 'cancelled', createdAt: daysAgo(200), completedAt: null }),
        oldPending: await command({ type: 'script', status: 'pending', createdAt: daysAgo(200), completedAt: null }),
        oldSent: await command({ type: 'script', status: 'sent', createdAt: daysAgo(200), completedAt: null }),
        recentCompleted: await command({ type: 'script', status: 'completed', createdAt: daysAgo(10) }),
        // Created long ago, completed recently: aged by completed_at.
        lateCompletion: await command({ type: 'script', status: 'failed', createdAt: daysAgo(200), completedAt: daysAgo(10) }),
        // patch_scan: only the newest terminal scan per device survives.
        scan1: await command({ type: 'patch_scan', status: 'completed', createdAt: daysAgo(300) }),
        scan2: await command({ type: 'patch_scan', status: 'timeout', createdAt: daysAgo(250) }),
        scan3: await command({ type: 'patch_scan', status: 'failed', createdAt: daysAgo(200) }),
        // A cancelled scan is invisible to the reader, so it never shields scan3 — and goes itself.
        scanCancelled: await command({ type: 'patch_scan', status: 'cancelled', createdAt: daysAgo(150) }),
        otherDeviceScan: await command({ type: 'patch_scan', status: 'completed', createdAt: daysAgo(300), deviceId: otherDeviceId }),
        // set_log_level: newest by completed_at.
        log1: await command({ type: 'set_log_level', status: 'completed', createdAt: daysAgo(300), completedAt: daysAgo(290) }),
        log2: await command({ type: 'set_log_level', status: 'failed', createdAt: daysAgo(310), completedAt: daysAgo(200) }),
        // OEM run / release: newest by created_at, any status.
        oemRun1: await command({ type: 'oem_update_run', status: 'completed', createdAt: daysAgo(300) }),
        oemRun2: await command({ type: 'oem_update_run', status: 'failed', createdAt: daysAgo(200) }),
        oemRelease: await command({ type: 'oem_update_release', status: 'completed', createdAt: daysAgo(300) }),
      };
      const all = Object.values(ids);

      const report = await runDeviceCommandRetention({ ...KNOBS, retentionDays: 120, forceReport: true });
      expect((await surviving(all)).size).toBe(all.length);

      const enforce = await runDeviceCommandRetention({ ...KNOBS, retentionDays: 120 });
      const left = await surviving(all);
      const deleted = ['oldCompleted', 'oldCancelled', 'scan1', 'scan2', 'scanCancelled', 'log1', 'oemRun1'] as const;
      for (const k of deleted) expect(left.has(ids[k]), `${k} should be deleted`).toBe(false);
      const kept = ['oldPending', 'oldSent', 'recentCompleted', 'lateCompletion', 'scan3', 'otherDeviceScan', 'log2', 'oemRun2', 'oemRelease'] as const;
      for (const k of kept) expect(left.has(ids[k]), `${k} should survive`).toBe(true);

      expect(affected(enforce)).toBe(deleted.length);
      expect(eligible(report)).toBe(affected(enforce));
    });

    it('keeps the newest device-remove uninstall even behind a newer uninstall without that reason', async () => {
      const older = await command({ type: 'self_uninstall', status: 'completed', createdAt: daysAgo(300), uninstallReasons: ['device_remove'] });
      const current = await command({ type: 'self_uninstall', status: 'failed', createdAt: daysAgo(250), uninstallReasons: ['device_remove'] });
      const newerOther = await command({ type: 'self_uninstall', status: 'completed', createdAt: daysAgo(200), uninstallReasons: null });

      const before = await withSystemDbAccessContext(() => getDeviceUninstallStatus(deviceId));
      await runDeviceCommandRetention({ ...KNOBS, retentionDays: 120 });
      const after = await withSystemDbAccessContext(() => getDeviceUninstallStatus(deviceId));

      const left = await surviving([older, current, newerOther]);
      expect(left.has(current)).toBe(true);
      expect(left.has(older)).toBe(false);
      // Not a device-remove uninstall, so no reader needs it.
      expect(left.has(newerOther)).toBe(false);
      expect(before).not.toBeNull();
      expect(after).toEqual(before);
    });

    it('splits rows an hour either side of the cutoff', async () => {
      const past = await command({ type: 'script', status: 'completed', createdAt: justPast(120) });
      const inside = await command({ type: 'script', status: 'completed', createdAt: justInside(120) });
      await runDeviceCommandRetention({ ...KNOBS, retentionDays: 120 });
      const left = await surviving([past, inside]);
      expect(left.has(past)).toBe(false);
      expect(left.has(inside)).toBe(true);
    });

    it('never runs below the 90-day install lookback, even when the payload asks for less', async () => {
      expect(commandKnobs.MIN_RETENTION_DAYS).toBe(90);
      const inside = await command({ type: 'install_patches', status: 'failed', createdAt: daysAgo(60) });
      const outside = await command({ type: 'install_patches', status: 'failed', createdAt: daysAgo(100) });
      const result = await runDeviceCommandRetention({ ...KNOBS, retentionDays: 30 });
      expect(result.retentionDays).toBe(90);
      const left = await surviving([inside, outside]);
      expect(left.has(inside)).toBe(true);
      expect(left.has(outside)).toBe(false);
    });
  });

  describe('device_filesystem_snapshots', () => {
    async function snapshot(scanPath: string, capturedAt: Date): Promise<string> {
      const [row] = await getTestDb().insert(deviceFilesystemSnapshots).values({
        deviceId, orgId, scanPath, capturedAt,
      }).returning({ id: deviceFilesystemSnapshots.id });
      return row!.id;
    }

    it('keeps the newest snapshot of each scan path and deletes the older ones past the window', async () => {
      const c1 = await snapshot('C:\\', daysAgo(30));
      const c2 = await snapshot('C:\\', daysAgo(20));
      const c3 = await snapshot('C:\\', daysAgo(10));
      const cRecent = await snapshot('C:\\', daysAgo(1));
      const dOnly = await snapshot('D:\\', daysAgo(40));
      // Another device's only C:\ scan: correlated on device_id, so this
      // device's newer C:\ rows must not supersede it.
      const [otherDevice] = await getTestDb().insert(deviceFilesystemSnapshots).values({
        deviceId: otherDeviceId, orgId, scanPath: 'C:\\', capturedAt: daysAgo(40),
      }).returning({ id: deviceFilesystemSnapshots.id });

      const report = await runFilesystemSnapshotRetention({ ...KNOBS, retentionDays: 7, forceReport: true });
      const enforce = await runFilesystemSnapshotRetention({ ...KNOBS, retentionDays: 7 });

      const rows = await getTestDb().select({ id: deviceFilesystemSnapshots.id }).from(deviceFilesystemSnapshots)
        .where(eq(deviceFilesystemSnapshots.deviceId, deviceId));
      // Old C:\ rows all have a newer row; only the recent one is newest. D:\ keeps its only scan.
      expect(new Set(rows.map((r) => r.id))).toEqual(new Set([cRecent, dOnly]));
      expect([c1, c2, c3].some((id) => rows.some((r) => r.id === id))).toBe(false);
      const otherRows = await getTestDb().select({ id: deviceFilesystemSnapshots.id }).from(deviceFilesystemSnapshots)
        .where(eq(deviceFilesystemSnapshots.deviceId, otherDeviceId));
      expect(otherRows.map((r) => r.id)).toEqual([otherDevice!.id]);
      expect(affected(enforce)).toBe(3);
      expect(eligible(report)).toBe(3);
    });

    it('keeps the newest old snapshot when every snapshot of a path is past the window', async () => {
      await snapshot('E:\\', daysAgo(30));
      await snapshot('E:\\', daysAgo(20));
      const newest = await snapshot('E:\\', daysAgo(10));
      await runFilesystemSnapshotRetention({ ...KNOBS, retentionDays: 7 });
      const rows = await getTestDb().select({ id: deviceFilesystemSnapshots.id }).from(deviceFilesystemSnapshots)
        .where(eq(deviceFilesystemSnapshots.scanPath, 'E:\\'));
      expect(rows.map((r) => r.id)).toEqual([newest]);
    });
  });

  describe('network_monitor_results', () => {
    async function monitor(): Promise<string> {
      const [row] = await getTestDb().insert(networkMonitors).values({
        orgId, name: 'm', monitorType: 'icmp_ping', target: '192.0.2.1',
      }).returning({ id: networkMonitors.id });
      return row!.id;
    }
    async function result(monitorId: string, at: Date): Promise<string> {
      const [row] = await getTestDb().insert(networkMonitorResults).values({
        monitorId, orgId, status: 'online', timestamp: at,
      }).returning({ id: networkMonitorResults.id });
      return row!.id;
    }

    it('deletes old results with a newer one, and a paused monitor keeps exactly its last result', async () => {
      const active = await monitor();
      const paused = await monitor();
      await result(active, daysAgo(60));
      await result(active, daysAgo(40));
      const activeRecent = await result(active, daysAgo(1));
      await result(paused, daysAgo(90));
      await result(paused, daysAgo(70));
      const pausedLast = await result(paused, daysAgo(50));

      const report = await runNetworkMonitorResultRetention({ ...KNOBS, retentionDays: 30, forceReport: true });
      const enforce = await runNetworkMonitorResultRetention({ ...KNOBS, retentionDays: 30 });

      const rows = await getTestDb().select({ id: networkMonitorResults.id }).from(networkMonitorResults)
        .where(inArray(networkMonitorResults.monitorId, [active, paused]));
      expect(new Set(rows.map((r) => r.id))).toEqual(new Set([activeRecent, pausedLast]));
      expect(affected(enforce)).toBe(4);
      expect(eligible(report)).toBe(4);
    });
  });

  describe('device_sessions', () => {
    async function session(isActive: boolean, at: Date, logoutAt: Date | null): Promise<string> {
      const [row] = await getTestDb().insert(deviceSessions).values({
        orgId, deviceId, username: 'user', isActive, loginAt: at, logoutAt, createdAt: at, updatedAt: at,
      }).returning({ id: deviceSessions.id });
      return row!.id;
    }

    it('deletes closed sessions past the window and never an active one', async () => {
      const oldClosed = await session(false, daysAgo(500), daysAgo(499));
      const oldClosedNoLogout = await session(false, daysAgo(500), null);
      const oldActive = await session(true, daysAgo(500), null);
      const recentClosed = await session(false, daysAgo(100), daysAgo(99));
      // Logged in long ago, logged out inside the window: aged by logout_at.
      const lateLogout = await session(false, daysAgo(500), daysAgo(10));
      // An hour either side of the cutoff.
      const justPastCutoff = await session(false, daysAgo(500), justPast(365));
      const justInsideCutoff = await session(false, daysAgo(500), justInside(365));

      const report = await runDeviceSessionRetention({ ...KNOBS, retentionDays: 365, forceReport: true });
      const enforce = await runDeviceSessionRetention({ ...KNOBS, retentionDays: 365 });

      const rows = await getTestDb().select({ id: deviceSessions.id }).from(deviceSessions)
        .where(eq(deviceSessions.deviceId, deviceId));
      expect(new Set(rows.map((r) => r.id))).toEqual(new Set([oldActive, recentClosed, lateLogout, justInsideCutoff]));
      expect([oldClosed, oldClosedNoLogout, justPastCutoff].some((id) => rows.some((r) => r.id === id))).toBe(false);
      expect(affected(enforce)).toBe(3);
      expect(eligible(report)).toBe(3);
    });
  });
});
