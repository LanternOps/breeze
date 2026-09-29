import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { backupProviderDevices } from '../db/schema';
import { getProviderCoverageForDevices } from './backupHealthReadModel';
import { providerLabelFor } from './backupHealthRows';
import type { SecurityProductEvidence } from './securityComplianceReportProducts';

/**
 * Third-party backup (Cove et al.) as posture-report product evidence (#6012).
 *
 * Shaped like the native-AV evidence: one push per linked device, `active`
 * only where that device has a fresh successful backup (`covered`, the unified
 * read model's verdict). buildSecurityProductInventory then reports
 * `deviceCoverage` = devices the provider backs up and `activeDeviceCoverage`
 * = devices with a successful backup in the window, and the product itself is
 * `active` only while at least one of them is — a connected vendor whose every
 * backup is failing is not a working control.
 *
 * Scope: only rows linked to `deviceIds` — the report's device population,
 * already narrowed to the caller's allowed sites and `config.sites`. Unlinked
 * vendor rows have no device to attribute and no site, so they never count.
 *
 * Label: the report is a customer deliverable, so it follows the same
 * per-connection portal-name toggle as the portal (spec D5 — "product: <label
 * per D5>"), read from the denormalized column on the org-axis device rows;
 * the partner-axis connection table is never read from this org context.
 */
export async function loadBackupProviderEvidence(
  orgId: string,
  deviceIds: string[],
  opts: { now?: Date } = {},
): Promise<{ evidence: SecurityProductEvidence[]; coveredDeviceCount: number }> {
  if (deviceIds.length === 0) return { evidence: [], coveredDeviceCount: 0 };

  const rows = await db
    .select({
      provider: backupProviderDevices.provider,
      portalShowProviderName: backupProviderDevices.portalShowProviderName,
      breezeDeviceId: backupProviderDevices.breezeDeviceId,
    })
    .from(backupProviderDevices)
    .where(and(
      eq(backupProviderDevices.orgId, orgId),
      inArray(backupProviderDevices.breezeDeviceId, deviceIds),
    ));

  const inScope = new Set(deviceIds);
  const linked = rows.filter(
    (row): row is typeof row & { breezeDeviceId: string } =>
      row.breezeDeviceId !== null && inScope.has(row.breezeDeviceId),
  );
  if (linked.length === 0) return { evidence: [], coveredDeviceCount: 0 };

  const linkedIds = [...new Set(linked.map((row) => row.breezeDeviceId))];
  const coverage = await getProviderCoverageForDevices(orgId, linkedIds, opts);

  const evidence: SecurityProductEvidence[] = [];
  const covered = new Set<string>();
  for (const row of linked) {
    const label = providerLabelFor(row.provider, {
      portalShowProviderName: row.portalShowProviderName,
      labels: 'portal',
    });
    if (!label) continue;
    const isCovered = coverage.get(row.breezeDeviceId)?.covered === true;
    if (isCovered) covered.add(row.breezeDeviceId);
    evidence.push({
      product: label,
      category: 'backup',
      active: isCovered,
      // The partner-axis connection (and its sync status) is not readable
      // from this org-scoped context — same as the Huntress/SentinelOne rows.
      lastSyncStatus: null,
      deviceIds: [row.breezeDeviceId],
    });
  }

  return { evidence, coveredDeviceCount: covered.size };
}
