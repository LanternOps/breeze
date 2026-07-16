import { and, eq, inArray } from 'drizzle-orm';

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { deviceVulnerabilities, vulnerabilities } from '../db/schema';

export type DeviceVulnerabilityCounts = { critical: number; high: number };

type FindingRow = { deviceId: string; vulnerabilityId: string };
type CatalogRow = { id: string; severity: string | null };

const VULNERABILITY_CATALOG_BATCH_SIZE = 10_000;

export function aggregateVulnerabilityCounts(
  findings: FindingRow[],
  catalogRows: CatalogRow[],
): Map<string, DeviceVulnerabilityCounts> {
  const catalogById = new Map(catalogRows.map((row) => [row.id, row]));
  const missingIds = [
    ...new Set(
      findings
        .map((finding) => finding.vulnerabilityId)
        .filter((id) => !catalogById.has(id)),
    ),
  ];
  if (missingIds.length > 0) {
    throw new Error(
      `Vulnerability catalog lookup incomplete: ${missingIds.length} referenced record(s) missing`,
    );
  }

  const counts = new Map<string, DeviceVulnerabilityCounts>();
  for (const finding of findings) {
    const severity = catalogById
      .get(finding.vulnerabilityId)
      ?.severity?.toLowerCase();
    if (severity !== 'critical' && severity !== 'high') continue;
    const current = counts.get(finding.deviceId) ?? { critical: 0, high: 0 };
    current[severity] += 1;
    counts.set(finding.deviceId, current);
  }
  return counts;
}

export async function loadOpenVulnerabilityCounts(
  deviceIds: string[],
): Promise<Map<string, DeviceVulnerabilityCounts>> {
  if (deviceIds.length === 0) return new Map();

  const findings = await db
    .select({
      deviceId: deviceVulnerabilities.deviceId,
      vulnerabilityId: deviceVulnerabilities.vulnerabilityId,
    })
    .from(deviceVulnerabilities)
    .where(
      and(
        inArray(deviceVulnerabilities.deviceId, deviceIds),
        eq(deviceVulnerabilities.status, 'open'),
      ),
    );

  const vulnerabilityIds = [
    ...new Set(findings.map((row) => row.vulnerabilityId)),
  ];
  if (vulnerabilityIds.length === 0) return new Map();

  const catalogRows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const rows: CatalogRow[] = [];
      for (
        let offset = 0;
        offset < vulnerabilityIds.length;
        offset += VULNERABILITY_CATALOG_BATCH_SIZE
      ) {
        const batch = vulnerabilityIds.slice(
          offset,
          offset + VULNERABILITY_CATALOG_BATCH_SIZE,
        );
        const batchRows = await db
          .select({ id: vulnerabilities.id, severity: vulnerabilities.severity })
          .from(vulnerabilities)
          .where(inArray(vulnerabilities.id, batch));
        rows.push(...batchRows);
      }
      return rows;
    }),
  );

  return aggregateVulnerabilityCounts(findings, catalogRows);
}
