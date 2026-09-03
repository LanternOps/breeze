import { escapeCsvCell, type EnrichedPortalDevice } from '@breeze/shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  backupJobs,
  devicePatches,
  deviceWarranty,
  devices,
  huntressAgents,
  s1Agents,
  securityStatus,
} from '../../db/schema';
import { classifyDeviceProtection } from './protection';

export async function enrichedDevicesForOrg(
  orgId: string,
  args: { page: number; limit: number; timezone: string },
) {
  const offset = (args.page - 1) * args.limit;
  const [countRows, rows] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(devices)
      .where(and(eq(devices.orgId, orgId), eq(devices.isEphemeral, false))),
    db
      .select({
        id: devices.id,
        hostname: devices.hostname,
        displayName: devices.displayName,
        osType: devices.osType,
        osVersion: devices.osVersion,
        status: devices.status,
        lastSeenAt: devices.lastSeenAt,
        lastPatchAt: sql<Date | null>`(
          select max(${devicePatches.installedAt})
          from ${devicePatches}
          where ${devicePatches.orgId} = ${orgId}
            and ${devicePatches.deviceId} = ${devices.id}
            and ${devicePatches.status} = 'installed'
        )`,
        realTimeProtection: securityStatus.realTimeProtection,
        provider: securityStatus.provider,
        avProducts: securityStatus.avProducts,
        securityUpdatedAt: securityStatus.updatedAt,
        hasS1Agent: sql<boolean>`exists (
          select 1 from ${s1Agents}
          where ${s1Agents.orgId} = ${orgId}
            and ${s1Agents.deviceId} = ${devices.id}
        )`,
        hasHuntressAgent: sql<boolean>`exists (
          select 1 from ${huntressAgents}
          where ${huntressAgents.orgId} = ${orgId}
            and ${huntressAgents.deviceId} = ${devices.id}
        )`,
        encryption: securityStatus.encryptionStatus,
        lastBackupAt: sql<Date | null>`(
          select max(${backupJobs.completedAt})
          from ${backupJobs}
          where ${backupJobs.orgId} = ${orgId}
            and ${backupJobs.deviceId} = ${devices.id}
            and ${backupJobs.status} in ('completed', 'partial')
        )`,
        warrantyEndsAt: deviceWarranty.warrantyEndDate,
      })
      .from(devices)
      .leftJoin(
        securityStatus,
        and(
          eq(securityStatus.deviceId, devices.id),
          eq(securityStatus.orgId, orgId),
        ),
      )
      .leftJoin(
        deviceWarranty,
        and(
          eq(deviceWarranty.deviceId, devices.id),
          eq(deviceWarranty.orgId, orgId),
        ),
      )
      .where(and(eq(devices.orgId, orgId), eq(devices.isEphemeral, false)))
      .orderBy(desc(devices.lastSeenAt), desc(devices.id))
      .limit(args.limit)
      .offset(offset),
  ]);

  const timestampFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: args.timezone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
  const formatTimestamp = (value: Date | null) =>
    value ? timestampFormatter.format(value) : null;

  const data: EnrichedPortalDevice[] = rows.map((row) => ({
    id: row.id,
    hostname: row.hostname,
    displayName: row.displayName,
    osType: row.osType,
    osVersion: row.osVersion,
    status: row.status,
    lastSeenAt: formatTimestamp(row.lastSeenAt),
    lastPatchAt: formatTimestamp(row.lastPatchAt),
    protection: classifyDeviceProtection({
      securityStatus: row.provider
        ? {
            provider: row.provider,
            realTimeProtection: row.realTimeProtection,
          }
        : null,
      hasS1Agent: row.hasS1Agent,
      hasHuntressAgent: row.hasHuntressAgent,
    }),
    encryption: row.encryption,
    lastBackupAt: formatTimestamp(row.lastBackupAt),
    warrantyEndsAt: row.warrantyEndsAt,
  }));

  return {
    data,
    pagination: {
      page: args.page,
      limit: args.limit,
      total: Number(countRows[0]?.count ?? 0),
    },
  };
}

export async function* devicesCsvForOrg(
  orgId: string,
  args: { timezone: string },
): AsyncIterable<string> {
  const csvRow = (values: readonly unknown[]) =>
    values.map((value) => escapeCsvCell(String(value ?? ''))).join(',');

  yield csvRow([
    'Device',
    'Type',
    'Status',
    'Last online',
    'Last patch',
    'Protection',
    'Encryption',
    'Last backup',
    'Warranty ends',
  ]) + '\n';

  for (let page = 1; ; page += 1) {
    const result = await enrichedDevicesForOrg(orgId, {
      page,
      limit: 250,
      timezone: args.timezone,
    });
    for (const row of result.data) {
      yield csvRow([
        row.displayName ?? row.hostname,
        row.osType ?? '',
        row.status,
        row.lastSeenAt ?? '',
        row.lastPatchAt ?? '',
        row.protection,
        row.encryption ?? '',
        row.lastBackupAt ?? '',
        row.warrantyEndsAt ?? '',
      ]) + '\n';
    }
    if (page * 250 >= result.pagination.total) break;
  }
}
