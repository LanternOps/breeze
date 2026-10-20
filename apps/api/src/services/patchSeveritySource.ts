/**
 * Provenance of a device-reported patch severity (#9387 gap 2).
 *
 * Windows Update leaves its MSRC rating empty for most updates, so the agent
 * derives a severity from the update's classification and title and reports
 * `severitySource: 'derived'` beside it (`'vendor'` for a real MSRC rating).
 * Ingest stores that on `device_patches.reported_severity_source`, always
 * written together with `reported_severity` (routes/agents/patches.ts).
 *
 * Read paths expose it as `severitySource` so the web can mark a derived value
 * as derived. It describes a DEVICE REPORT only: when the shared, trusted
 * `patches.severity` supplied the displayed value, there is no device
 * provenance and `severitySource` is null.
 */
import { and, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { db } from '../db';
import { devicePatches, devices, patches } from '../db/schema';
import type { OutstandingDeviceScope } from './patchOutstandingDevices';

export type ReportedSeveritySource = 'vendor' | 'derived';

/** Device-reported severity a catalog row can fall back to, and its provenance. */
export type CatalogReportedSeverity = {
  /** Most severe value reported by an in-scope device (never 'unknown'). */
  severity: string;
  /**
   * 'derived' only when EVERY in-scope report at that severity was derived;
   * 'vendor' when at least one of them is a vendor rating; null when none
   * carried provenance (agents older than #9387).
   */
  source: ReportedSeveritySource | null;
};

// Same rank as AGGREGATED_EFFECTIVE_PATCH_SEVERITY_SQL in patchSeverityOverlay.ts.
const SEVERITY_RANK: Record<string, number> = { critical: 0, important: 1, moderate: 2, low: 3 };

function narrowSource(value: string | null): ReportedSeveritySource | null {
  return value === 'vendor' || value === 'derived' ? value : null;
}

/**
 * For GET /patches (one row per catalog entry, no device row in scope): the
 * most severe value the caller's in-scope devices reported for each patch,
 * with its provenance — only for patches whose shared `patches.severity` is
 * still unknown, since a trusted value always wins over device reports.
 *
 * `scope` is the caller's device-row predicates from
 * `resolveOutstandingDeviceScope` (accessible orgs, `?orgId=`, site
 * narrowing): `patches` is global, so without it one tenant would see another
 * tenant's device provenance. Runs in the request's DB context, like the
 * outstanding-device overlay it sits beside.
 */
export async function loadCatalogReportedSeverities(
  patchIds: readonly string[],
  scope: OutstandingDeviceScope,
): Promise<Map<string, CatalogReportedSeverity>> {
  if (patchIds.length === 0) return new Map();

  // Distinct (patch, severity, source) triples: a handful per patch, so the
  // worst-level pick below is cheap and stays in one round trip.
  const rows = await db
    .select({
      patchId: devicePatches.patchId,
      severity: sql<string>`${devicePatches.reportedSeverity}::text`,
      source: devicePatches.reportedSeveritySource,
    })
    .from(devicePatches)
    .innerJoin(devices, eq(devices.id, devicePatches.deviceId))
    .innerJoin(patches, eq(patches.id, devicePatches.patchId))
    .where(and(
      inArray(devicePatches.patchId, [...patchIds]),
      isNotNull(devicePatches.reportedSeverity),
      ne(devicePatches.reportedSeverity, 'unknown'),
      sql`COALESCE(${patches.severity}::text, 'unknown') = 'unknown'`,
      ...scope,
    ))
    .groupBy(devicePatches.patchId, devicePatches.reportedSeverity, devicePatches.reportedSeveritySource);

  const byPatch = new Map<string, { rank: number; severity: string; sources: Set<string | null> }>();
  for (const row of rows) {
    const rank = SEVERITY_RANK[row.severity];
    if (rank === undefined) continue;
    const current = byPatch.get(row.patchId);
    if (!current || rank < current.rank) {
      byPatch.set(row.patchId, { rank, severity: row.severity, sources: new Set([row.source]) });
    } else if (rank === current.rank) {
      current.sources.add(row.source);
    }
  }

  const result = new Map<string, CatalogReportedSeverity>();
  for (const [patchId, { severity, sources }] of byPatch) {
    const narrowed = [...sources].map(narrowSource);
    const source: ReportedSeveritySource | null = narrowed.every((s) => s === 'derived')
      ? 'derived'
      : narrowed.includes('vendor') ? 'vendor' : null;
    result.set(patchId, { severity, source });
  }
  return result;
}

/**
 * `severitySource` for a catalog row: the provenance of the device reports
 * only when the severity the row displays IS that device-reported value. A
 * row showing the trusted shared severity (or still unknown) gets null.
 */
export function catalogSeveritySource(
  displayedSeverity: string | null | undefined,
  reported: CatalogReportedSeverity | undefined,
): ReportedSeveritySource | null {
  if (!reported || !displayedSeverity || displayedSeverity === 'unknown') return null;
  return reported.severity === displayedSeverity ? reported.source : null;
}
