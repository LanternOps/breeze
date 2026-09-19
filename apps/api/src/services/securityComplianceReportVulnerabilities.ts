import { and, eq, inArray } from 'drizzle-orm';

import {
  db,
  runOutsideDbContext,
  withSystemDbAccessContext,
} from '../db';
import {
  deviceVulnerabilities,
  vulnerabilities,
  vulnerabilitySources,
} from '../db/schema';

export type DeviceVulnerabilityCounts = { critical: number; high: number };

type FindingRow = { deviceId: string; vulnerabilityId: string };
type CatalogRow = { id: string; severity: string | null };

/** The global CVE catalog is not tenant-scoped; reads are batched so a large
 *  org cannot build an unbounded IN list. */
const CATALOG_BATCH_SIZE = 10_000;

/** Raw catalog projection shared by BOTH the posture control line and the
 *  #5784 W04 detail artifact. One join, one implementation. */
type CatalogRecord = {
  id: string;
  cveId: string | null;
  title: string | null;
  severity: string | null;
  knownExploited: boolean;
  epssScore: number | null;
  patchAvailable: boolean;
};

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

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * THE catalog join. Both the posture control line (`loadOpenVulnerabilityCounts`)
 * and the #5784 W04 detail artifact (`loadOpenFindings`) resolve their findings
 * through this one function, so the two surfaces can never disagree about the
 * same number in front of the same customer.
 *
 * The catalog is global (not tenant-scoped) and the caller is always inside a
 * request's own org context, so the read is elevated exactly as
 * `vulnerabilitySeverityForFindings` does. Missing rows are NOT filled in with
 * defaults — the caller's `missingIds` guard must stay reachable.
 */
async function loadVulnerabilityCatalog(
  vulnerabilityIds: string[],
): Promise<Map<string, CatalogRecord>> {
  const ids = [...new Set(vulnerabilityIds)];
  const result = new Map<string, CatalogRecord>();
  if (ids.length === 0) return result;

  await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      for (let offset = 0; offset < ids.length; offset += CATALOG_BATCH_SIZE) {
        const batch = ids.slice(offset, offset + CATALOG_BATCH_SIZE);
        const rows = await db
          .select({
            id: vulnerabilities.id,
            cveId: vulnerabilities.cveId,
            title: vulnerabilities.description,
            severity: vulnerabilities.severity,
            knownExploited: vulnerabilities.knownExploited,
            epssScore: vulnerabilities.epssScore,
            patchAvailable: vulnerabilities.patchAvailable,
          })
          .from(vulnerabilities)
          .where(inArray(vulnerabilities.id, batch));

        for (const row of rows ?? []) {
          result.set(row.id, {
            id: row.id,
            cveId: row.cveId ?? null,
            title: row.title ?? null,
            severity: row.severity?.toLowerCase() ?? null,
            knownExploited: row.knownExploited === true,
            epssScore: toNumberOrNull(row.epssScore),
            patchAvailable: row.patchAvailable === true,
          });
        }
      }
    }),
  );

  return result;
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

  const catalog = await loadVulnerabilityCatalog(vulnerabilityIds);

  // Only pass through rows the catalog actually produced — aggregateVulnerabilityCounts'
  // missingIds guard must stay reachable, never invent zeros for a missing catalog row.
  const catalogRows: CatalogRow[] = [...catalog.values()].map((record) => ({
    id: record.id,
    severity: record.severity,
  }));

  return aggregateVulnerabilityCounts(findings, catalogRows);
}

/**
 * Per-source ingestion health (#5784 W04). The report states this UP FRONT: a
 * count that is low because MSRC has not synced in a week must say so rather
 * than print a reassuring number. A source that has NEVER synced comes back
 * `lastSyncAt: null` — unmeasured, never zero.
 */
export type VulnerabilityFeedFreshness = {
  name: string;
  lastSyncAt: string | null;
  lastStatus: string | null;
};

export async function loadFeedFreshness(): Promise<VulnerabilityFeedFreshness[]> {
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () =>
      db
        .select({
          source: vulnerabilitySources.source,
          lastSuccessfulSyncAt: vulnerabilitySources.lastSuccessfulSyncAt,
          lastSyncStatus: vulnerabilitySources.lastSyncStatus,
        })
        .from(vulnerabilitySources),
    ),
  );

  return (rows ?? []).map((row) => ({
    name: row.source,
    lastSyncAt:
      row.lastSuccessfulSyncAt instanceof Date
        ? row.lastSuccessfulSyncAt.toISOString()
        : (row.lastSuccessfulSyncAt ?? null),
    lastStatus: row.lastSyncStatus ?? null,
  }));
}

/** One enriched device finding, joined to the global catalog. */
export type OpenVulnerabilityFinding = {
  deviceId: string;
  vulnerabilityId: string;
  status: string;
  cveId: string;
  title: string | null;
  severity: string | null;
  knownExploited: boolean;
  epssScore: number | null;
  riskScore: number | null;
  patchAvailable: boolean;
  acceptedBy: string | null;
  acceptedUntil: string | null;
  resolvedAt: string | null;
};

export type LoadOpenFindingsOptions = {
  /** Defaults to `['open']` — the posture-equivalent scope. */
  statuses?: string[];
};

/**
 * The per-finding rows behind the #5784 W04 detail artifact. Same findings
 * query and same catalog join as the posture control line above, so the
 * detail report and the posture control line can never diverge; an incomplete
 * catalog join FAILS the run rather than shrinking the number.
 */
export async function loadOpenFindings(
  deviceIds: string[],
  opts: LoadOpenFindingsOptions = {},
): Promise<OpenVulnerabilityFinding[]> {
  if (deviceIds.length === 0) return [];
  const statuses = opts.statuses ?? ['open'];
  if (statuses.length === 0) return [];

  const rows = await db
    .select({
      deviceId: deviceVulnerabilities.deviceId,
      vulnerabilityId: deviceVulnerabilities.vulnerabilityId,
      status: deviceVulnerabilities.status,
      riskScore: deviceVulnerabilities.riskScore,
      acceptedBy: deviceVulnerabilities.acceptedBy,
      acceptedUntil: deviceVulnerabilities.acceptedUntil,
      resolvedAt: deviceVulnerabilities.resolvedAt,
    })
    .from(deviceVulnerabilities)
    .where(
      and(
        inArray(deviceVulnerabilities.deviceId, deviceIds),
        inArray(deviceVulnerabilities.status, statuses),
      ),
    );

  const findings = rows ?? [];
  if (findings.length === 0) return [];

  const catalog = await loadVulnerabilityCatalog(
    findings.map((row) => row.vulnerabilityId),
  );

  const missingIds = [
    ...new Set(
      findings
        .map((row) => row.vulnerabilityId)
        .filter((id) => !catalog.has(id)),
    ),
  ];
  if (missingIds.length > 0) {
    throw new Error(
      `Vulnerability catalog lookup incomplete: ${missingIds.length} referenced record(s) missing`,
    );
  }

  const toIso = (value: unknown): string | null => {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return value.toISOString();
    return String(value);
  };

  return findings.map((row) => {
    const record = catalog.get(row.vulnerabilityId) as CatalogRecord;
    return {
      deviceId: row.deviceId,
      vulnerabilityId: row.vulnerabilityId,
      status: row.status,
      cveId: record.cveId ?? row.vulnerabilityId,
      title: record.title ?? null,
      severity: record.severity,
      knownExploited: record.knownExploited,
      epssScore: record.epssScore,
      riskScore: toNumberOrNull(row.riskScore),
      patchAvailable: record.patchAvailable,
      acceptedBy: row.acceptedBy ?? null,
      acceptedUntil: toIso(row.acceptedUntil),
      resolvedAt: toIso(row.resolvedAt),
    };
  });
}
