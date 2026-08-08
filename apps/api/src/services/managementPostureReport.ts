import { sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { devices } from '../db/schema';
import {
  MANAGEMENT_POSTURE_CATEGORIES,
  type ManagementPostureCategory,
} from '../routes/agents/schemas';

export { MANAGEMENT_POSTURE_CATEGORIES, type ManagementPostureCategory };

/**
 * Fleet management-posture report (#3244).
 *
 * Aggregates the existing `devices.management_posture` jsonb (written by the
 * agent's mgmtdetect scan) into a fleet-level migration/decommission report.
 * The jsonb stays the single source of truth — no denormalized detections
 * table, no new columns.
 *
 * CRITICAL — two queries, not one. The detection roll-up and the coverage
 * denominators must NOT be computed in a single GROUP BY with a LEFT JOIN
 * LATERAL: that collapses never-scanned, scanned-with-category-absent, and
 * scanned-with-empty-array devices into one identical (product NULL,
 * status NULL) group, so a never-scanned device becomes indistinguishable
 * from a verified-clean one — precisely the failure this report exists to
 * prevent (an endpoint stranding when the incumbent agent is uninstalled on
 * a machine whose Breeze enrollment was never verified). Detections use a
 * CROSS JOIN LATERAL; coverage is computed separately with no lateral join.
 * See docs/superpowers/specs/onboarding-signup/
 * 2026-08-08-fleet-migration-posture-report-design.md.
 */

export function isManagementPostureCategory(v: string): v is ManagementPostureCategory {
  return (MANAGEMENT_POSTURE_CATEGORIES as readonly string[]).includes(v);
}

export interface PostureDetectionRow {
  orgId: string;
  product: string;
  /** 'active' | 'installed' | 'unknown' — passed through verbatim, never merged. */
  status: string;
  /** Distinct devices carrying this product/status (a duplicate entry in one
   *  device's posture array counts the device once). */
  deviceCount: number;
  /** Subset of deviceCount whose posture scan is within the staleness window. */
  freshDeviceCount: number;
}

export interface PostureCoverageRow {
  orgId: string;
  totalDevices: number;
  /** management_posture IS NULL — status UNKNOWN, never "clean". */
  neverScanned: number;
  /** Scanned, but the scan is older than the staleness window. */
  stale: number;
  /** Scanned with the category absent OR an empty array — verified none detected
   *  (regardless of scan age; cross-reference `stale` for freshness). */
  scannedNoneDetected: number;
}

export interface OrgPostureSummary extends PostureCoverageRow {
  /** Distinct devices with >=1 detection in this category (any status). */
  detectedDevices: number;
  /** Subset of detectedDevices with a fresh scan. */
  freshDetectedDevices: number;
  products: Array<Omit<PostureDetectionRow, 'orgId'>>;
}

export interface PostureSummary {
  category: ManagementPostureCategory;
  stalenessDays: number;
  totals: {
    totalDevices: number;
    neverScanned: number;
    stale: number;
    scannedNoneDetected: number;
    detectedDevices: number;
    freshDetectedDevices: number;
  };
  orgs: OrgPostureSummary[];
}

interface QueryOpts {
  category: ManagementPostureCategory;
  stalenessDays: number;
  /** Additional scope conditions (org narrowing, site allowlist, …), built by
   *  the caller with Drizzle helpers over the `devices` columns. Required so a
   *  forgotten scope is a compile-time-visible choice, not a silent default. */
  scope: SQL | undefined;
}

/** Base liveness predicate shared by every query in this report. Mirrors the
 *  device list / stats conventions: decommissioned devices and ephemeral
 *  Quick Support devices are not part of the managed fleet. */
function liveDevices(scope: SQL | undefined): SQL {
  const base = sql`${devices.status} != 'decommissioned' AND ${devices.isEphemeral} = false`;
  return scope ? sql`${base} AND (${scope})` : base;
}

function freshPredicate(stalenessDays: number): SQL {
  return sql`(${devices.managementPosture}->>'collectedAt')::timestamptz > now() - make_interval(days => ${stalenessDays}::int)`;
}

function categoryArray(category: ManagementPostureCategory): SQL {
  // ::text — the bare bind param is ambiguous between the (jsonb, text) and
  // (jsonb, int) overloads of the -> operator.
  return sql`COALESCE(${devices.managementPosture}->'categories'->${category}::text, '[]'::jsonb)`;
}

type Row = Record<string, unknown>;

async function execute(query: SQL): Promise<Row[]> {
  const result = await db.execute(query);
  return result as unknown as Row[];
}

/**
 * Query (a): one row per (org, product, status) with distinct-device counts.
 * Devices with no detections in the category simply produce no rows here —
 * the coverage query supplies their denominators.
 */
export async function getPostureDetections(opts: QueryOpts): Promise<PostureDetectionRow[]> {
  const rows = await execute(sql`
    SELECT ${devices.orgId} AS org_id,
           e.value->>'name'   AS product,
           e.value->>'status' AS status,
           count(DISTINCT ${devices.id})::int AS device_count,
           (count(DISTINCT ${devices.id}) FILTER (
             WHERE ${freshPredicate(opts.stalenessDays)}
           ))::int AS fresh_device_count
    FROM ${devices}
    CROSS JOIN LATERAL jsonb_array_elements(${categoryArray(opts.category)}) e
    WHERE ${liveDevices(opts.scope)}
    GROUP BY 1, 2, 3
    ORDER BY 1, 2, 3
  `);
  return rows.map((r) => ({
    orgId: String(r.org_id),
    product: String(r.product),
    status: String(r.status),
    deviceCount: Number(r.device_count),
    freshDeviceCount: Number(r.fresh_device_count),
  }));
}

/**
 * Query (b): coverage denominators per org, computed WITHOUT any lateral join
 * so the three no-detection populations stay distinguishable. Also counts the
 * distinct detected devices per org (via EXISTS, still not a join) so the
 * summary can partition the fleet.
 */
export async function getPostureCoverage(opts: QueryOpts): Promise<Array<PostureCoverageRow & {
  detectedDevices: number;
  freshDetectedDevices: number;
}>> {
  const hasDetection = sql`jsonb_array_length(${categoryArray(opts.category)}) > 0`;
  const rows = await execute(sql`
    SELECT ${devices.orgId} AS org_id,
           count(*)::int AS total_devices,
           (count(*) FILTER (WHERE ${devices.managementPosture} IS NULL))::int AS never_scanned,
           (count(*) FILTER (WHERE ${devices.managementPosture} IS NOT NULL
             AND NOT (${freshPredicate(opts.stalenessDays)})))::int AS stale,
           (count(*) FILTER (WHERE ${devices.managementPosture} IS NOT NULL
             AND NOT (${hasDetection})))::int AS scanned_none_detected,
           (count(*) FILTER (WHERE ${devices.managementPosture} IS NOT NULL
             AND ${hasDetection}))::int AS detected_devices,
           (count(*) FILTER (WHERE ${devices.managementPosture} IS NOT NULL
             AND ${hasDetection} AND ${freshPredicate(opts.stalenessDays)}))::int AS fresh_detected_devices
    FROM ${devices}
    WHERE ${liveDevices(opts.scope)}
    GROUP BY 1
    ORDER BY 1
  `);
  return rows.map((r) => ({
    orgId: String(r.org_id),
    totalDevices: Number(r.total_devices),
    neverScanned: Number(r.never_scanned),
    stale: Number(r.stale),
    scannedNoneDetected: Number(r.scanned_none_detected),
    detectedDevices: Number(r.detected_devices),
    freshDetectedDevices: Number(r.fresh_detected_devices),
  }));
}

/**
 * The summary endpoint's payload: coverage denominators are always present for
 * every org that has devices, and a detection count is never emitted without
 * them. An org with detections but no coverage row cannot happen (coverage
 * scans the same base population); if it ever did, the org would be dropped
 * rather than shown without denominators, so we throw instead — loudly wrong
 * beats quietly wrong here.
 */
export async function getManagementPostureSummary(opts: QueryOpts): Promise<PostureSummary> {
  const [detections, coverage] = await Promise.all([
    getPostureDetections(opts),
    getPostureCoverage(opts),
  ]);

  const byOrg = new Map<string, OrgPostureSummary>();
  for (const c of coverage) {
    byOrg.set(c.orgId, { ...c, products: [] });
  }
  for (const d of detections) {
    const org = byOrg.get(d.orgId);
    if (!org) {
      // See doc comment: never emit a detection count without denominators.
      throw new Error(
        `posture summary invariant violated: detections for org ${d.orgId} without a coverage row`
      );
    }
    org.products.push({
      product: d.product,
      status: d.status,
      deviceCount: d.deviceCount,
      freshDeviceCount: d.freshDeviceCount,
    });
  }

  const totals = {
    totalDevices: 0,
    neverScanned: 0,
    stale: 0,
    scannedNoneDetected: 0,
    detectedDevices: 0,
    freshDetectedDevices: 0,
  };
  for (const org of byOrg.values()) {
    totals.totalDevices += org.totalDevices;
    totals.neverScanned += org.neverScanned;
    totals.stale += org.stale;
    totals.scannedNoneDetected += org.scannedNoneDetected;
    totals.detectedDevices += org.detectedDevices;
    totals.freshDetectedDevices += org.freshDetectedDevices;
  }

  return {
    category: opts.category,
    stalenessDays: opts.stalenessDays,
    totals,
    orgs: [...byOrg.values()],
  };
}

export interface PostureDeviceRow {
  id: string;
  orgId: string;
  siteId: string;
  hostname: string;
  displayName: string | null;
  status: string;
  osType: string;
  lastSeenAt: string | null;
  /** Posture scan timestamp (ISO) — null only if the jsonb lacks collectedAt. */
  collectedAt: string | null;
  /** Detection status for the requested product on this device. */
  detectionStatus: string;
  detectionVersion: string | null;
}

/**
 * Drill-down behind a summary count: the devices carrying `product` in the
 * requested category (optionally narrowed to one detection status).
 */
export async function getPostureDevices(opts: QueryOpts & {
  product: string;
  detectionStatus?: string;
  limit: number;
  offset: number;
}): Promise<{ devices: PostureDeviceRow[]; total: number }> {
  const statusFilter = opts.detectionStatus ?? null;
  const matchesProduct = sql`
    SELECT e.value->>'status' AS status, e.value->>'version' AS version
    FROM jsonb_array_elements(${categoryArray(opts.category)}) e
    WHERE e.value->>'name' = ${opts.product}
      AND (${statusFilter}::text IS NULL OR e.value->>'status' = ${statusFilter}::text)
  `;

  const [countRows, rows] = await Promise.all([
    execute(sql`
      SELECT count(*)::int AS total
      FROM ${devices}
      WHERE ${liveDevices(opts.scope)}
        AND EXISTS (${matchesProduct})
    `),
    execute(sql`
      SELECT ${devices.id} AS id,
             ${devices.orgId} AS org_id,
             ${devices.siteId} AS site_id,
             ${devices.hostname} AS hostname,
             ${devices.displayName} AS display_name,
             ${devices.status} AS status,
             ${devices.osType} AS os_type,
             ${devices.lastSeenAt} AS last_seen_at,
             ${devices.managementPosture}->>'collectedAt' AS collected_at,
             det.status AS detection_status,
             det.version AS detection_version
      FROM ${devices}
      CROSS JOIN LATERAL (
        ${matchesProduct}
        ORDER BY CASE e.value->>'status'
          WHEN 'active' THEN 0 WHEN 'installed' THEN 1 ELSE 2 END
        LIMIT 1
      ) det
      WHERE ${liveDevices(opts.scope)}
      ORDER BY ${devices.hostname}, ${devices.id}
      LIMIT ${opts.limit} OFFSET ${opts.offset}
    `),
  ]);

  return {
    total: Number(countRows[0]?.total ?? 0),
    devices: rows.map((r) => ({
      id: String(r.id),
      orgId: String(r.org_id),
      siteId: String(r.site_id),
      hostname: String(r.hostname),
      displayName: r.display_name == null ? null : String(r.display_name),
      status: String(r.status),
      osType: String(r.os_type),
      lastSeenAt: r.last_seen_at == null ? null : new Date(r.last_seen_at as string | Date).toISOString(),
      collectedAt: r.collected_at == null ? null : String(r.collected_at),
      detectionStatus: String(r.detection_status),
      detectionVersion: r.detection_version == null ? null : String(r.detection_version),
    })),
  };
}
