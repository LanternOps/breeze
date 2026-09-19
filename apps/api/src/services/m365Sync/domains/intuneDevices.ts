import { db } from '../../../db';
import { m365IntuneDevices } from '../../../db/schema';
import { canonicalHash } from '../hash';
import {
  M365_SYNC_PRIMARY_SOURCE_KEY,
  type DomainPersistResult, type M365SyncActionResult, type PersistContext,
} from '../types';
import {
  markEntitiesStale, planEntityWrites, sqlExcluded, sqlFalse, sqlNull, writeEntityChunks,
} from './persist';

interface DeviceItem {
  id?: string;
  deviceName?: string | null;
  operatingSystem?: string | null;
  osVersion?: string | null;
  complianceState?: string | null;
  lastSyncDateTime?: string | null;
  userPrincipalName?: string | null;
  managedDeviceOwnerType?: string | null;
  enrolledDateTime?: string | null;
  model?: string | null;
  manufacturer?: string | null;
  serialNumber?: string | null;
  azureADDeviceId?: string | null;
  managementAgent?: string | null;
  jailBroken?: string | null;
}

type ComplianceBucket = 'devices_compliant' | 'devices_noncompliant' | 'devices_in_grace' | 'devices_unknown';

/**
 * Graph's `complianceState` is an open string that passes through to the column
 * untouched (spec §3.2). Only the ROLLUP counters bucket it, and the bucketing
 * is explicit rather than "anything not compliant is noncompliant": `unknown`
 * and `configManager` are genuinely not a compliance verdict, and reporting
 * them as non-compliant would invent a security finding.
 */
const COMPLIANCE_BUCKETS: Record<string, ComplianceBucket> = {
  compliant: 'devices_compliant',
  noncompliant: 'devices_noncompliant',
  conflict: 'devices_noncompliant',
  error: 'devices_noncompliant',
  ingraceperiod: 'devices_in_grace',
  unknown: 'devices_unknown',
  configmanager: 'devices_unknown',
};

export function complianceBucket(state: string | null | undefined): ComplianceBucket {
  if (!state) return 'devices_unknown';
  return COMPLIANCE_BUCKETS[state.trim().toLowerCase()] ?? 'devices_unknown';
}

function projection(item: DeviceItem): Record<string, unknown> {
  return {
    deviceName: item.deviceName ?? null,
    operatingSystem: item.operatingSystem ?? null,
    osVersion: item.osVersion ?? null,
    complianceState: item.complianceState ?? null,
    // In the hash on purpose: an Intune device's last check-in is the single
    // most useful freshness fact on the row, and these rows are bounded by
    // device count, so the churn is affordable (spec §3.2).
    lastSyncDateTime: item.lastSyncDateTime ?? null,
    userPrincipalName: item.userPrincipalName ?? null,
    managedDeviceOwnerType: item.managedDeviceOwnerType ?? null,
    enrolledDateTime: item.enrolledDateTime ?? null,
    model: item.model ?? null,
    manufacturer: item.manufacturer ?? null,
    serialNumber: item.serialNumber ?? null,
    azureADDeviceId: item.azureADDeviceId ?? null,
    managementAgent: item.managementAgent ?? null,
    jailBroken: item.jailBroken ?? null,
  };
}

export async function persistIntuneDevices(
  ctx: PersistContext,
  result: M365SyncActionResult,
): Promise<DomainPersistResult> {
  const items = result.items as DeviceItem[];
  const primaryOk = result.sources[M365_SYNC_PRIMARY_SOURCE_KEY.intune_devices] === 'ok';
  const complete = primaryOk && !result.truncated;

  const plan = planEntityWrites(ctx, items, complete, (item) => {
    if (!item.id) return null;
    const p = projection(item);
    return {
      graphId: item.id,
      coreHash: canonicalHash(p),
      row: {
        orgId: ctx.orgId,
        graphId: item.id,
        deviceName: p.deviceName as string | null,
        operatingSystem: p.operatingSystem as string | null,
        osVersion: p.osVersion as string | null,
        complianceState: p.complianceState as string | null,
        lastIntuneSyncAt: p.lastSyncDateTime ? new Date(p.lastSyncDateTime as string) : null,
        userPrincipalName: p.userPrincipalName as string | null,
        ownerType: p.managedDeviceOwnerType as string | null,
        enrolledAt: p.enrolledDateTime ? new Date(p.enrolledDateTime as string) : null,
        model: p.model as string | null,
        manufacturer: p.manufacturer as string | null,
        serialNumber: p.serialNumber as string | null,
        azureAdDeviceId: p.azureADDeviceId as string | null,
        managementAgent: p.managementAgent as string | null,
        jailBroken: p.jailBroken as string | null,
        coreHash: canonicalHash(p),
        firstSeenAt: ctx.now,
        lastChangedAt: ctx.now,
        isStale: false,
        staleSince: null,
      },
    };
  });

  await writeEntityChunks(plan.rows, async (chunk) => {
    await db.insert(m365IntuneDevices).values(chunk).onConflictDoUpdate({
      target: [m365IntuneDevices.orgId, m365IntuneDevices.graphId],
      // breeze_device_id is deliberately ABSENT: it is written only by W05's
      // link reconciliation, and listing it here would null an existing link on
      // every run.
      set: {
        deviceName: sqlExcluded('device_name'),
        operatingSystem: sqlExcluded('operating_system'),
        osVersion: sqlExcluded('os_version'),
        complianceState: sqlExcluded('compliance_state'),
        lastIntuneSyncAt: sqlExcluded('last_intune_sync_at'),
        userPrincipalName: sqlExcluded('user_principal_name'),
        ownerType: sqlExcluded('owner_type'),
        enrolledAt: sqlExcluded('enrolled_at'),
        model: sqlExcluded('model'),
        manufacturer: sqlExcluded('manufacturer'),
        serialNumber: sqlExcluded('serial_number'),
        azureAdDeviceId: sqlExcluded('azure_ad_device_id'),
        managementAgent: sqlExcluded('management_agent'),
        jailBroken: sqlExcluded('jail_broken'),
        coreHash: sqlExcluded('core_hash'),
        lastChangedAt: sqlExcluded('last_changed_at'),
        isStale: sqlFalse(),
        staleSince: sqlNull(),
      },
    });
  }, ctx);

  const stale = plan.staleIds.length
    ? await markEntitiesStale(m365IntuneDevices as never, ctx.orgId, plan.staleIds, ctx.now, ctx)
    : 0;

  const counts: Record<string, number> = {
    devices_total: items.length,
    devices_compliant: 0,
    devices_noncompliant: 0,
    devices_in_grace: 0,
    devices_unknown: 0,
  };
  for (const item of items) {
    const bucket = complianceBucket(item.complianceState);
    counts[bucket] = (counts[bucket] ?? 0) + 1;
  }

  return { inserted: plan.inserted, updated: plan.updated, unchanged: plan.unchanged, stale, complete, counts };
}
