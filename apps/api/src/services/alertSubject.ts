import { and, eq, inArray, sql } from 'drizzle-orm';
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
    .where(and(
      inArray(sql`${backupProviderDevices.id}::text`, [...new Set(workloads.map(row => row.ownerRef!))]),
      inArray(backupProviderDevices.orgId, [...new Set(workloads.map(row => row.orgId))]),
    )) : [];
  const topology = rows.filter(row => row.ownerKind === 'topology_site' && row.topologySiteId && !row.siteName);
  const siteRows = topology.length ? await db.select({ id: sites.id, orgId: sites.orgId, name: sites.name })
    .from(sites).where(and(
      inArray(sites.id, [...new Set(topology.flatMap(row => row.topologySiteId ? [row.topologySiteId] : []))]),
      inArray(sites.orgId, [...new Set(topology.map(row => row.orgId))]),
    )) : [];
  // Recheck the org/reference pair: the batched predicates may load another org's owner.
  const workloadsByOwner = new Map(workloadRows.map(item => [`${item.orgId}:${item.id}`, item]));
  const sitesByOwner = new Map(siteRows.map(item => [`${item.orgId}:${item.id}`, item]));
  return rows.map(row => {
    const workload = workloadsByOwner.get(`${row.orgId}:${row.ownerRef}`);
    const site = sitesByOwner.get(`${row.orgId}:${row.topologySiteId}`);
    return { ...row, ...formatAlertSubject({ ...row, siteName: row.siteName || site?.name }, workload ? {
      ...workload,
      // Only consult the registry when the portal explicitly requests a visible provider.
      providerLabel: options.portal && workload.portalShowProviderName
        ? providerLabelFor(workload.provider, { labels: 'portal', portalShowProviderName: true }) : null,
    } : undefined, options) };
  });
}
