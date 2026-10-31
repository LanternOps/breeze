import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { formatAlertSubject, type AlertSubjectSource } from '@breeze/shared';
import { db } from '../db';
import { backupProviderCustomers, backupProviderDevices, organizations, sites } from '../db/schema';
import { providerLabelFor } from './backupHealthRows';

/** Batch display enrichment inside the caller's DB context; every owner read is org-pinned. */
export async function enrichAlertSubjects<T extends AlertSubjectSource & { orgId: string }>(
  rows: T[],
  options: { portal?: boolean } = {},
) {
  const workloads = rows.filter(row => row.ownerKind === 'backup_workload' && row.ownerRef);
  const workloadRows = workloads.length ? await db.select({
    id: backupProviderDevices.id,
    orgId: backupProviderDevices.orgId,
    dataSources: backupProviderDevices.dataSources,
    provider: backupProviderDevices.provider,
    portalShowProviderName: backupProviderDevices.portalShowProviderName,
    customerName: sql<string | null>`COALESCE(${backupProviderCustomers.vendorCustomerName}, ${organizations.name})`,
  }).from(backupProviderDevices)
    .leftJoin(backupProviderCustomers, and(
      eq(backupProviderCustomers.id, backupProviderDevices.customerId),
      eq(backupProviderCustomers.orgId, backupProviderDevices.orgId),
      eq(backupProviderCustomers.connectionId, backupProviderDevices.connectionId),
    ))
    .leftJoin(organizations, eq(organizations.id, backupProviderDevices.orgId))
    // owner_ref is text; compare as text so stale/malformed refs cannot cause UUID errors.
    .where(or(...workloads.map(row => and(
      eq(backupProviderDevices.orgId, row.orgId),
      sql`${backupProviderDevices.id}::text = ${row.ownerRef}`,
    )))) : [];
  const topology = rows.filter(row => row.ownerKind === 'topology_site' && row.topologySiteId && !row.siteName);
  const siteRows = topology.length ? await db.select({ id: sites.id, orgId: sites.orgId, name: sites.name })
    .from(sites).where(and(
      inArray(sites.id, topology.flatMap(row => row.topologySiteId ? [row.topologySiteId] : [])),
      inArray(sites.orgId, [...new Set(topology.map(row => row.orgId))]),
    )) : [];
  return rows.map(row => {
    const workload = workloadRows.find(item => item.id === row.ownerRef && item.orgId === row.orgId);
    const site = siteRows.find(item => item.id === row.topologySiteId && item.orgId === row.orgId);
    return { ...row, ...formatAlertSubject({ ...row, siteName: row.siteName || site?.name }, workload ? {
      ...workload,
      // Only consult the registry when the portal explicitly requests a visible provider.
      providerLabel: options.portal && workload.portalShowProviderName
        ? providerLabelFor(workload.provider, { labels: 'portal', portalShowProviderName: true }) : null,
    } : undefined, options) };
  });
}
