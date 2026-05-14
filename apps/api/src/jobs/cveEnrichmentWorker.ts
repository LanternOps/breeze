import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '../db';
import { patches, thirdPartyPackageCatalog } from '../db/schema';
import {
  queryOsvForPackage,
  OsvRateLimitError,
  OsvServerError,
} from '../services/osvClient';

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
      version: patches.version,
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

  let consecutiveServerErrors = 0;

  for (const row of rows) {
    summary.scanned++;
    if (!row.ecosystem || !row.packageId) continue;
    if (!row.version) {
      // Without a version we can't query OSV meaningfully. Skip quietly.
      if (process.env.LOG_LEVEL === 'debug') {
        // eslint-disable-next-line no-console
        console.debug('[cveEnrichment] skipping row without version', {
          patchId: row.patchId,
          packageId: row.packageId,
        });
      }
      continue;
    }

    try {
      const osv = await queryOsvForPackage({
        ecosystem: row.ecosystem,
        name: row.packageId,
        version: row.version,
      });

      consecutiveServerErrors = 0;

      if (osv.cveIds.length === 0) continue;

      const currentRank = SEVERITY_RANK[row.currentSeverity ?? 'unknown'] ?? 0;
      const osvRank = osv.maxSeverity ? (SEVERITY_RANK[osv.maxSeverity] ?? 0) : 0;
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
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[cveEnrichment] OSV lookup failed', {
        patchId: row.patchId,
        ecosystem: row.ecosystem,
        packageId: row.packageId,
        version: row.version,
        error: err instanceof Error ? err.message : String(err),
      });
      summary.errors++;

      if (err instanceof OsvRateLimitError) {
        // Stop hammering OSV — abort and rethrow so the scheduler backs off.
        throw err;
      }
      if (err instanceof OsvServerError) {
        consecutiveServerErrors++;
        if (consecutiveServerErrors >= 3) {
          throw err;
        }
      } else {
        consecutiveServerErrors = 0;
      }
    }
  }

  return summary;
}
