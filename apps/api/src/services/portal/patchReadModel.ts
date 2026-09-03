import { and, countDistinct, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  devicePatches,
  OUTSTANDING_DEVICE_PATCH_STATUSES,
  patches,
} from '../../db/schema';

export function portalMonthWindow(now: Date, timezone: string) {
  // Bind the anchor as an ISO string: Drizzle's postgres-js driver leaves
  // timestamp serialization to column mappers, which a raw fragment bypasses,
  // and a bare Date makes postgres.js throw at bind time (#4562 W04 fix).
  const anchor = now.toISOString();
  const localStart = sql<Date>`
    date_trunc('month', ${anchor}::timestamptz at time zone ${timezone})
  `;
  const start = sql<Date>`${localStart} at time zone ${timezone}`;
  const end = sql<Date>`
    (${localStart} + interval '1 month') at time zone ${timezone}
  `;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  const value = (type: string) =>
    parts.find((part) => part.type === type)!.value;

  return { start, end, month: `${value('year')}-${value('month')}` };
}

export async function patchesAppliedTile(
  orgId: string,
  args: { timezone: string; now: Date },
) {
  const { start, end, month } = portalMonthWindow(
    args.now,
    args.timezone,
  );

  const [sourceRows, appliedRows, outstandingRows] = await Promise.all([
    db
      .select({ id: devicePatches.id })
      .from(devicePatches)
      .where(eq(devicePatches.orgId, orgId))
      .limit(1),
    db
      .select({ applied: sql<number>`count(*)::int` })
      .from(devicePatches)
      .where(and(
        eq(devicePatches.orgId, orgId),
        eq(devicePatches.status, 'installed'),
        gte(devicePatches.installedAt, start),
        lt(devicePatches.installedAt, end),
      )),
    db
      .select({
        devicesWithOutstandingCritical:
          countDistinct(devicePatches.deviceId),
      })
      .from(devicePatches)
      .innerJoin(patches, eq(devicePatches.patchId, patches.id))
      .where(and(
        eq(devicePatches.orgId, orgId),
        inArray(devicePatches.status, [...OUTSTANDING_DEVICE_PATCH_STATUSES]),
        eq(patches.severity, 'critical'),
      )),
  ]);

  const applied = Number(appliedRows[0]?.applied ?? 0);
  const devicesWithOutstandingCritical = Number(
    outstandingRows[0]?.devicesWithOutstandingCritical ?? 0,
  );

  if (sourceRows.length === 0) {
    return {
      status: 'no_data' as const,
      applied: null,
      devicesWithOutstandingCritical: null,
      month,
      timezone: args.timezone,
      asOf: args.now.toISOString(),
    };
  }

  return {
    status: 'ok' as const,
    applied,
    devicesWithOutstandingCritical,
    month,
    timezone: args.timezone,
    asOf: args.now.toISOString(),
  };
}
