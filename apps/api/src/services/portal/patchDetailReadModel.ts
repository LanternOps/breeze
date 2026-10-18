import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db';
import { devicePatches, devices, patches, OUTSTANDING_DEVICE_PATCH_STATUSES } from '../../db/schema';
import {
  AGGREGATED_EFFECTIVE_PATCH_SEVERITY_SQL,
  EFFECTIVE_PATCH_SEVERITY_SQL,
} from '../patchSeverityOverlay';

// W05 (#7735): closed patch projection; the organization comes from portalAuth.
// 'missing' is a tombstone (not a pending patch) and 'skipped' is policy noise,
// so only these statuses are ever visible. Never project lastError,
// failureCount, rollbackAvailable, scope, or any policy/approval/job data.
const VISIBLE_STATUSES = [...OUTSTANDING_DEVICE_PATCH_STATUSES, 'installed', 'failed'] as const;

type PageArgs = { page: number; limit: number; now: Date };

const orgCondition = (orgId: string) => and(
  eq(devicePatches.orgId, orgId),
  eq(devices.orgId, orgId),
  eq(devices.isEphemeral, false),
  inArray(devicePatches.status, [...VISIBLE_STATUSES]),
);

const SEVERITY_RANK = sql`CASE ${EFFECTIVE_PATCH_SEVERITY_SQL}::text
  WHEN 'critical' THEN 0 WHEN 'important' THEN 1 WHEN 'moderate' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`;
const AGGREGATED_SEVERITY_RANK = sql`CASE ${AGGREGATED_EFFECTIVE_PATCH_SEVERITY_SQL}::text
  WHEN 'critical' THEN 0 WHEN 'important' THEN 1 WHEN 'moderate' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`;
const STATUS_RANK = sql`CASE ${devicePatches.status}::text WHEN 'pending' THEN 0 WHEN 'failed' THEN 1 ELSE 2 END`;

const countWhere = (status: string) =>
  sql<number>`(count(*) filter (where ${devicePatches.status} = ${status}))::int`;

type DeviceRow = {
  title: string;
  severity: string | null;
  version: string | null;
  kbArticleUrl: string | null;
  status: string;
  installedAt: Date | null;
  installedVersion: string | null;
  availableVersion: string | null;
  lastCheckedAt: Date | null;
};

const projectDevice = (row: DeviceRow) => ({
  title: row.title,
  severity: row.severity ?? 'unknown',
  version: row.version ?? null,
  kbArticleUrl: row.kbArticleUrl ?? null,
  status: row.status,
  installedAt: row.installedAt?.toISOString() ?? null,
  installedVersion: row.installedVersion ?? null,
  availableVersion: row.availableVersion ?? null,
  lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
});

type SummaryRow = {
  title: string;
  severity: string | null;
  version: string | null;
  kbArticleUrl: string | null;
  pendingDevices: number;
  failedDevices: number;
  installedDevices: number;
  lastCheckedAt: Date | null;
};

const projectSummary = (row: SummaryRow) => ({
  title: row.title,
  severity: row.severity ?? 'unknown',
  version: row.version ?? null,
  kbArticleUrl: row.kbArticleUrl ?? null,
  pendingDevices: row.pendingDevices,
  failedDevices: row.failedDevices,
  installedDevices: row.installedDevices,
  lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
});

// One row per patch; patches.id is the grouping key and the final tiebreaker.
export async function patchDetailSummary(orgId: string, args: PageArgs) {
  const [totals, rows] = await Promise.all([
    db.select({ total: sql<number>`count(distinct ${devicePatches.patchId})::int` })
      .from(devicePatches)
      .innerJoin(devices, eq(devices.id, devicePatches.deviceId))
      .where(orgCondition(orgId)),
    db.select({
      title: patches.title,
      severity: AGGREGATED_EFFECTIVE_PATCH_SEVERITY_SQL,
      version: patches.version,
      kbArticleUrl: patches.kbArticleUrl,
      pendingDevices: countWhere('pending'),
      failedDevices: countWhere('failed'),
      installedDevices: countWhere('installed'),
      lastCheckedAt: sql<Date | null>`max(${devicePatches.lastCheckedAt})`.mapWith(devicePatches.lastCheckedAt),
    }).from(devicePatches)
      .innerJoin(devices, eq(devices.id, devicePatches.deviceId))
      .innerJoin(patches, eq(patches.id, devicePatches.patchId))
      .where(orgCondition(orgId))
      .groupBy(patches.id)
      .orderBy(
        // Outstanding work first: patches with pending/failed devices, then worst severity.
        sql`(count(*) filter (where ${devicePatches.status} in ('pending', 'failed')) = 0)`,
        AGGREGATED_SEVERITY_RANK,
        asc(patches.title),
        asc(patches.id),
      )
      .limit(args.limit).offset((args.page - 1) * args.limit),
  ]);
  const total = totals[0]?.total ?? 0;
  return {
    asOf: args.now.toISOString(),
    dataStatus: total > 0 ? ('ok' as const) : ('no_data' as const),
    data: rows.map(projectSummary),
    pagination: { page: args.page, limit: args.limit, total },
  };
}

export async function patchDetailDevicePage(orgId: string, deviceId: string, args: PageArgs) {
  const [device] = await db.select({ id: devices.id }).from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId), eq(devices.isEphemeral, false))).limit(1);
  if (!device) return null;
  const condition = and(orgCondition(orgId), eq(devicePatches.deviceId, deviceId));
  const [totals, rows] = await Promise.all([
    db.select({ total: sql<number>`count(*)::int` }).from(devicePatches)
      .innerJoin(devices, eq(devices.id, devicePatches.deviceId)).where(condition),
    db.select({
      title: patches.title,
      severity: EFFECTIVE_PATCH_SEVERITY_SQL,
      version: patches.version,
      kbArticleUrl: patches.kbArticleUrl,
      status: devicePatches.status,
      installedAt: devicePatches.installedAt,
      installedVersion: devicePatches.installedVersion,
      availableVersion: devicePatches.availableVersion,
      lastCheckedAt: devicePatches.lastCheckedAt,
    }).from(devicePatches)
      .innerJoin(devices, eq(devices.id, devicePatches.deviceId))
      .innerJoin(patches, eq(patches.id, devicePatches.patchId))
      .where(condition)
      .orderBy(STATUS_RANK, SEVERITY_RANK, asc(patches.title), asc(devicePatches.id))
      .limit(args.limit).offset((args.page - 1) * args.limit),
  ]);
  const total = totals[0]?.total ?? 0;
  return {
    asOf: args.now.toISOString(),
    dataStatus: total > 0 ? ('ok' as const) : ('no_data' as const),
    data: rows.map(projectDevice),
    pagination: { page: args.page, limit: args.limit, total },
  };
}
