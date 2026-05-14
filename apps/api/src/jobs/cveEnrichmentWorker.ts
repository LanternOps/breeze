/**
 * CVE Enrichment Worker
 *
 * Scans third-party patches that have a matching catalog entry with
 * `osv_ecosystem` set, queries OSV.dev for known vulnerabilities, and
 * updates `patches.cve_ids` + bumps `patches.severity` when OSV reports
 * a higher severity.
 */

import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { db } from '../db';
import { patches, thirdPartyPackageCatalog } from '../db/schema';
import { queryOsvForPackage } from '../services/osvClient';

const SEVERITY_RANK: Record<string, number> = {
  critical: 4,
  important: 3,
  moderate: 2,
  low: 1,
  unknown: 0,
};

export interface CveEnrichmentSummary {
  scanned: number;
  updated: number;
  errors: number;
}

export async function runCveEnrichmentBatch(
  { limit = 100 }: { limit?: number } = {}
): Promise<CveEnrichmentSummary> {
  const summary: CveEnrichmentSummary = { scanned: 0, updated: 0, errors: 0 };

  const rows = await db
    .select({
      patchId: patches.id,
      packageId: patches.packageId,
      currentSeverity: patches.severity,
      ecosystem: thirdPartyPackageCatalog.osvEcosystem,
      version: sql<string>`COALESCE(${patches.metadata}->>'version', '')`,
    })
    .from(patches)
    .innerJoin(
      thirdPartyPackageCatalog,
      and(
        eq(thirdPartyPackageCatalog.source, patches.source),
        eq(thirdPartyPackageCatalog.packageId, patches.packageId)
      )
    )
    .where(
      and(
        eq(patches.source, 'third_party'),
        isNotNull(thirdPartyPackageCatalog.osvEcosystem)
      )
    )
    .limit(limit);

  for (const row of rows) {
    summary.scanned++;
    if (!row.ecosystem || !row.packageId) continue;

    try {
      const osv = await queryOsvForPackage({
        ecosystem: row.ecosystem,
        name: row.packageId,
        version: row.version || '0.0.0',
      });

      if (osv.cveIds.length === 0) continue;

      const currentRank = SEVERITY_RANK[row.currentSeverity ?? 'unknown'] ?? 0;
      const osvRank = osv.maxSeverity ? SEVERITY_RANK[osv.maxSeverity] : 0;
      const nextSeverity = osvRank > currentRank ? osv.maxSeverity : row.currentSeverity;

      await db
        .update(patches)
        .set({
          cveIds: osv.cveIds,
          severity: nextSeverity,
          updatedAt: new Date(),
        })
        .where(eq(patches.id, row.patchId));
      summary.updated++;
    } catch (_err) {
      summary.errors++;
    }
  }

  return summary;
}
