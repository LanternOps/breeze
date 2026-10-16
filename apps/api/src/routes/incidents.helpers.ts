import { and, asc, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { unionAll } from 'drizzle-orm/pg-core';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { db } from '../db';
import { incidents, huntressIncidents, s1Threats, edrDetections, type IncidentTimelineEntry } from '../db/schema';
import { isEdrProviderKey, type EdrProviderKey } from '../services/edrProviders/providerKeys';
import { edrSitePredicate } from '../services/edrProviders/readScope';
import type { AuthContext } from '../middleware/auth';
import { dateFromSqlValue } from '../services/portal/sqlTimestamp';
import {
  ALLOWED_EVIDENCE_STORAGE_SCHEMES,
  ALLOWED_STATUS_TRANSITIONS,
  listIncidentsSchema,
  type IncidentActionStatus,
  type IncidentStatus,
} from './incidents.validation';

export function canTransitionStatus(
  from: IncidentStatus,
  to: IncidentStatus
): boolean {
  if (from === to) {
    return true;
  }
  return ALLOWED_STATUS_TRANSITIONS[from].includes(to);
}

export function asTimeline(value: unknown): IncidentTimelineEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value as IncidentTimelineEntry[];
}

export function appendTimeline(
  current: unknown,
  entry: IncidentTimelineEntry
): IncidentTimelineEntry[] {
  const timeline = asTimeline(current);
  return [...timeline, entry];
}

export function normalizeTimelineWithSort(value: unknown): IncidentTimelineEntry[] {
  const timeline = asTimeline(value);
  return [...timeline].sort((a, b) => a.at.localeCompare(b.at));
}

export function isControlledEvidenceStoragePath(storagePath: string): boolean {
  if (storagePath.includes('..')) {
    return false;
  }

  const match = storagePath.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (!match) {
    return false;
  }

  const scheme = (match[1] ?? '').toLowerCase();
  return ALLOWED_EVIDENCE_STORAGE_SCHEMES.has(scheme);
}

export function computeSha256FromBase64(contentBase64: string): string {
  const trimmed = contentBase64.replace(/\s+/g, '');
  if (trimmed.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) || trimmed.length % 4 !== 0) {
    throw new Error('Invalid base64 content');
  }
  const buffer = Buffer.from(trimmed, 'base64');
  if (buffer.length === 0) {
    throw new Error('Invalid base64 content');
  }
  return createHash('sha256').update(buffer).digest('hex');
}

export function isContainmentSuccess(status: IncidentActionStatus): boolean {
  return status === 'completed';
}

export function getPagination(query: z.infer<typeof listIncidentsSchema>): { page: number; limit: number; offset: number } {
  const page = query.page ?? 1;
  const limit = query.limit ?? 50;
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

export function resolveOrgFilter(
  auth: AuthContext,
  queryOrgId: string | undefined,
  column: PgColumn
): { condition?: SQL; error?: { message: string; status: number } } {
  if (auth.scope === 'organization') {
    if (!auth.orgId) {
      return { error: { message: 'Organization context required', status: 403 } };
    }
    if (queryOrgId && queryOrgId !== auth.orgId) {
      return { error: { message: 'Access to this organization denied', status: 403 } };
    }
    return { condition: eq(column, auth.orgId) };
  }

  if (auth.scope === 'partner') {
    if (queryOrgId) {
      if (!auth.canAccessOrg(queryOrgId)) {
        return { error: { message: 'Access to this organization denied', status: 403 } };
      }
      return { condition: eq(column, queryOrgId) };
    }

    const orgIds = auth.accessibleOrgIds ?? [];
    if (orgIds.length === 0) {
      return { condition: eq(column, '00000000-0000-0000-0000-000000000000') };
    }
    return { condition: inArray(column, orgIds) };
  }

  if (auth.scope === 'system' && queryOrgId) {
    return { condition: eq(column, queryOrgId) };
  }

  return {};
}

export async function getIncidentWithOrgCheck(incidentId: string, auth: AuthContext) {
  const conditions: SQL[] = [eq(incidents.id, incidentId)];
  const orgCondition = auth.orgCondition(incidents.orgId);
  if (orgCondition) {
    conditions.push(orgCondition);
  }

  const [incident] = await db
    .select()
    .from(incidents)
    .where(and(...conditions))
    .limit(1);

  return incident ?? null;
}

export type IncidentFeedSource = 'breeze' | 'huntress' | 's1' | EdrProviderKey;

export type IncidentFeedRow = {
  kind: 'tracked' | 'finding';
  /** 'breeze' | 'huntress' | 's1', or an EDR-framework provider key (#8166). */
  source: IncidentFeedSource;
  sourceId: string;
  title: string;
  severity: 'p1' | 'p2' | 'p3' | 'p4';
  edrStatus: string | null;
  status: string | null;
  deviceId: string | null;
  detectedAt: string;
  trackedIncidentId: string | null;
  linkOut: string | null;
};

export function resolveFindingLinkOut(details: unknown): string | null {
  if (details && typeof details === 'object') {
    const d = details as Record<string, unknown>;
    const url = d.portalUrl ?? d.url ?? d.link;
    if (typeof url === 'string' && /^https:\/\//.test(url)) return url;
  }
  return null;
}

export class FeedScopeError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function severityRankToLabel(rank: number): IncidentFeedRow['severity'] {
  return rank === 1 ? 'p1' : rank === 2 ? 'p2' : rank === 4 ? 'p4' : 'p3';
}

// EDR severity string -> sortable rank (1=p1 highest .. 4=p4). Mirrors the
// web mapEdrSeverity: critical->1, high->2, medium->3, low->4, else 3.
function edrSeverityRank(col: SQL<unknown> | PgColumn): SQL<number> {
  return sql<number>`CASE lower(coalesce(${col}, ''))
    WHEN 'critical' THEN 1
    WHEN 'high' THEN 2
    WHEN 'medium' THEN 3
    WHEN 'low' THEN 4
    ELSE 3 END`;
}

// EDR-framework normalized severity -> rank. `info` is p4 like `low`;
// `unknown` stays p3 (an unclassified vendor finding is not demoted).
function edrFrameworkSeverityRank(): SQL<number> {
  return sql<number>`CASE ${edrDetections.severity}
    WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3
    WHEN 'low' THEN 4 WHEN 'info' THEN 4 ELSE 3 END`;
}

// Native p1..p4 enum -> same rank space.
function nativeSeverityRank(): SQL<number> {
  return sql<number>`CASE ${incidents.severity}
    WHEN 'p1' THEN 1 WHEN 'p2' THEN 2 WHEN 'p4' THEN 4 ELSE 3 END`;
}

export type FeedLegKey = 'tracked' | 'huntress' | 's1' | 'edr';
export type FeedLeg = { key: FeedLegKey; include: boolean; query: any };

/**
 * Combine the included feed legs into one UNION ALL, preserving leg order.
 * Returns null when no leg is included (empty feed); a single included leg is
 * returned as-is. Production uses Drizzle's VARIADIC `unionAll(q0, q1, ...)`
 * (a flat UNION ALL, the same SQL the old per-combination ternary emitted);
 * the combiner is injectable so the 2^n include matrix is unit-testable
 * without a DB. The legs are typed `any` because Drizzle cannot infer the
 * union of table names across a dynamic list.
 */
export function foldLegs(
  legs: FeedLeg[],
  combine: (queries: any[]) => any = (queries) => (unionAll as any)(...queries),
): any | null {
  const queries = legs.filter((l) => l.include).map((l) => l.query);
  if (queries.length === 0) return null;
  if (queries.length === 1) return queries[0];
  return combine(queries);
}

export type IncidentFeedParams = {
  orgId?: string;
  kind?: 'tracked' | 'finding';
  source?: IncidentFeedSource;
  limit: number;
  offset: number;
  /**
   * True when the caller holds `devices:read`. The raw EDR finding legs
   * (huntress + s1) expose device telemetry (device ids + hostnames embedded in
   * titles), so a caller with only `alerts:read` must not see them — when this
   * is `false` the huntress/s1 legs are omitted entirely and only native
   * tracked incidents are returned. Required (no default) so omission is a
   * compile error rather than a fail-open runtime default.
   */
  hasDevicesRead: boolean;
  /**
   * Site-axis allowlist resolved by the route via `resolveSiteAllowedDeviceIds`
   * (mirrors GET /huntress/incidents + /sentinelone/threats). `null` means the
   * caller is NOT site-restricted (no narrowing). A concrete array narrows the
   * EDR legs to findings on these devices, keeping null-device (provider-level)
   * findings visible. Site is an app-layer authz axis Postgres RLS does NOT
   * defend, so this must be applied in the query. Required (no default) so
   * callers must declare their site-restriction posture explicitly.
   */
  allowedDeviceIds: string[] | null;
  /**
   * The caller's site allowlist (`permissions.allowedSiteIds`), or null when
   * not site-restricted. Used only by the EDR-framework leg (#8166, D14): a
   * detection whose device link was cleared by an org move / device delete
   * keeps its `last_site_id`, and only callers allowed that site see it.
   * Required for the same reason as `allowedDeviceIds`.
   */
  allowedSiteIds: string[] | null;
};

/**
 * Build the feed's count + rows queries WITHOUT executing them. Returns null
 * when the requested kind/source filters exclude every union leg (empty feed).
 *
 * Splitting construction from execution lets a DB-less unit test call
 * `.toSQL()` on the rows query to assert the union legs carry `.as()` aliases
 * and the ORDER BY references the case-sensitive `"detectedAt"` column —
 * exactly the two failure modes that made `GET /incidents/feed` throw at
 * query-build time. May throw {@link FeedScopeError} for an invalid org scope.
 */
export function buildIncidentFeedQueries(
  auth: AuthContext,
  params: IncidentFeedParams
) {
  const orgIncidents = resolveOrgFilter(auth, params.orgId, incidents.orgId);
  const orgHuntress = resolveOrgFilter(auth, params.orgId, huntressIncidents.orgId);
  const orgS1 = resolveOrgFilter(auth, params.orgId, s1Threats.orgId);
  const orgEdr = resolveOrgFilter(auth, params.orgId, edrDetections.orgId);
  if (orgIncidents.error) {
    throw new FeedScopeError(orgIncidents.error.status, orgIncidents.error.message);
  }

  // Site-axis narrowing for the EDR finding legs. Site is an app-layer authz
  // axis Postgres RLS cannot see, so a site-restricted caller (org user with
  // `permissions.allowedSiteIds`) must not read Huntress/S1 findings — deviceId
  // or hostnames-in-titles — for devices outside their allowed sites. `null`
  // means the caller is unrestricted (no narrowing). For a restricted caller we
  // keep null-device (provider-level) findings visible and only exclude rows on
  // foreign-site devices. Mirrors GET /huntress/incidents (huntress.ts) and GET
  // /sentinelone/threats (sentinelOne.ts): with no allowed devices the `in (…)`
  // branch matches nothing, so only the null-device branch survives.
  const siteDevicePredicate = (deviceIdColumn: PgColumn): SQL | undefined => {
    if (!params.allowedDeviceIds) return undefined;
    return params.allowedDeviceIds.length > 0
      ? (or(isNull(deviceIdColumn), inArray(deviceIdColumn, params.allowedDeviceIds)) as SQL)
      : isNull(deviceIdColumn);
  };

  // Native tracked incidents. Every raw sql<...> value carries `.as('<key>')`
  // matching its object key — drizzle requires aliases to reference subquery
  // fields, and the alias set/order must be identical across all three legs.
  const trackedQ = db
    .select({
      kind: sql<string>`'tracked'`.as('kind'),
      source: sql<string>`'breeze'`.as('source'),
      sourceId: sql<string>`${incidents.id}::text`.as('sourceId'),
      title: sql<string>`${incidents.title}`.as('title'),
      rank: nativeSeverityRank().as('rank'),
      edrStatus: sql<string | null>`null::text`.as('edrStatus'),
      status: sql<string | null>`${incidents.status}::text`.as('status'),
      deviceId: sql<string | null>`(${incidents.affectedDevices}->>0)`.as('deviceId'),
      detectedAt: sql<Date>`${incidents.detectedAt}`.as('detectedAt'),
      trackedIncidentId: sql<string | null>`${incidents.id}::text`.as('trackedIncidentId'),
      details: sql<unknown>`null::jsonb`.as('details'),
    })
    .from(incidents)
    .where(orgIncidents.condition);

  // Huntress findings NOT already promoted.
  const huntressQ = db
    .select({
      kind: sql<string>`'finding'`.as('kind'),
      source: sql<string>`'huntress'`.as('source'),
      sourceId: sql<string>`${huntressIncidents.huntressIncidentId}`.as('sourceId'),
      title: sql<string>`${huntressIncidents.title}`.as('title'),
      rank: edrSeverityRank(huntressIncidents.severity).as('rank'),
      edrStatus: sql<string | null>`${huntressIncidents.status}`.as('edrStatus'),
      status: sql<string | null>`null::text`.as('status'),
      deviceId: sql<string | null>`${huntressIncidents.deviceId}::text`.as('deviceId'),
      detectedAt: sql<Date>`coalesce(${huntressIncidents.reportedAt}, ${huntressIncidents.createdAt})`.as('detectedAt'),
      trackedIncidentId: sql<string | null>`null::text`.as('trackedIncidentId'),
      details: sql<unknown>`${huntressIncidents.details}`.as('details'),
    })
    .from(huntressIncidents)
    .where(
      and(
        orgHuntress.condition,
        siteDevicePredicate(huntressIncidents.deviceId),
        sql`NOT EXISTS (SELECT 1 FROM incidents i WHERE i.org_id = ${huntressIncidents.orgId}
          AND i.source_type = 'huntress_incident' AND i.source_ref = ${huntressIncidents.huntressIncidentId})`
      )
    );

  // S1 findings NOT already promoted.
  const s1Q = db
    .select({
      kind: sql<string>`'finding'`.as('kind'),
      source: sql<string>`'s1'`.as('source'),
      sourceId: sql<string>`${s1Threats.s1ThreatId}`.as('sourceId'),
      title: sql<string>`coalesce(${s1Threats.threatName}, 'SentinelOne threat')`.as('title'),
      rank: edrSeverityRank(s1Threats.severity).as('rank'),
      edrStatus: sql<string | null>`${s1Threats.status}`.as('edrStatus'),
      status: sql<string | null>`null::text`.as('status'),
      deviceId: sql<string | null>`${s1Threats.deviceId}::text`.as('deviceId'),
      detectedAt: sql<Date>`coalesce(${s1Threats.detectedAt}, ${s1Threats.createdAt})`.as('detectedAt'),
      trackedIncidentId: sql<string | null>`null::text`.as('trackedIncidentId'),
      details: sql<unknown>`${s1Threats.details}`.as('details'),
    })
    .from(s1Threats)
    .where(
      and(
        orgS1.condition,
        siteDevicePredicate(s1Threats.deviceId),
        sql`NOT EXISTS (SELECT 1 FROM incidents i WHERE i.org_id = ${s1Threats.orgId}
          AND i.source_type = 's1_threat' AND i.source_ref = ${s1Threats.s1ThreatId})`
      )
    );

  // EDR-framework detections (#8166) NOT already promoted. Live rows only (a
  // D13 tombstone is never a feed row); site rule per D14 (see readScope.ts).
  // `details` is projected as NULL: vendor jsonb never reaches the feed.
  const edrSourceFilter = params.source && isEdrProviderKey(params.source)
    ? eq(edrDetections.provider, params.source)
    : undefined;
  const edrQ = db
    .select({
      kind: sql<string>`'finding'`.as('kind'),
      source: sql<string>`${edrDetections.provider}`.as('source'),
      sourceId: sql<string>`${edrDetections.id}::text`.as('sourceId'),
      title: sql<string>`coalesce(${edrDetections.title}, ${edrDetections.threatName}, 'EDR detection')`.as('title'),
      rank: edrFrameworkSeverityRank().as('rank'),
      edrStatus: sql<string | null>`${edrDetections.status}`.as('edrStatus'),
      status: sql<string | null>`null::text`.as('status'),
      deviceId: sql<string | null>`${edrDetections.breezeDeviceId}::text`.as('deviceId'),
      detectedAt: sql<Date>`coalesce(${edrDetections.detectedAt}, ${edrDetections.createdAt})`.as('detectedAt'),
      trackedIncidentId: sql<string | null>`null::text`.as('trackedIncidentId'),
      details: sql<unknown>`null::jsonb`.as('details'),
    })
    .from(edrDetections)
    .where(
      and(
        orgEdr.condition,
        isNull(edrDetections.detachedAt),
        edrSourceFilter,
        edrSitePredicate({ allowedDeviceIds: params.allowedDeviceIds, allowedSiteIds: params.allowedSiteIds }),
        sql`NOT EXISTS (SELECT 1 FROM incidents i WHERE i.org_id = ${edrDetections.orgId}
          AND i.source_type = 'edr_detection' AND i.source_ref = ${edrDetections.id}::text)`
      )
    );

  // Determine which legs to include based on filters. The raw EDR finding legs
  // require `devices:read`; a caller with only `alerts:read` (hasDevicesRead ===
  // false) gets native tracked incidents only. Fail-closed: only include EDR
  // when the caller explicitly signals devices:read. This composes with the
  // kind/source filters: a no-devices-read caller passing source=huntress simply
  // yields no legs → empty feed (null), not an error.
  const findingLegsAllowed = params.hasDevicesRead === true;
  const isEdrSource = params.source !== undefined && isEdrProviderKey(params.source);
  const includeTracked = params.kind !== 'finding' && (params.source === undefined || params.source === 'breeze');
  const includeHuntress = findingLegsAllowed && params.kind !== 'tracked' && (params.source === undefined || params.source === 'huntress');
  const includeS1 = findingLegsAllowed && params.kind !== 'tracked' && (params.source === undefined || params.source === 's1');
  const includeEdrLeg = findingLegsAllowed && params.kind !== 'tracked' && (params.source === undefined || isEdrSource);
  if (!includeTracked && !includeHuntress && !includeS1 && !includeEdrLeg) return null;
  const baseQ: any = foldLegs([
    { key: 'tracked', include: includeTracked, query: trackedQ },
    { key: 'huntress', include: includeHuntress, query: huntressQ },
    { key: 's1', include: includeS1, query: s1Q },
    { key: 'edr', include: includeEdrLeg, query: edrQ },
  ]);
  const sub = baseQ.as('feed');

  const countQuery = db.select({ count: sql<number>`count(*)` }).from(sub);
  const rowsQuery = db
    .select()
    .from(sub)
    // Order by the actual aliased subquery columns. `rank` ascending (p1
    // first), `detectedAt` descending. Referencing `sub.rank`/`sub.detectedAt`
    // emits correctly-quoted identifiers — raw unquoted `detected_at` would
    // fold to lowercase and fail (`column "detected_at" does not exist`).
    // `(source, sourceId)` is the mandatory tiebreaker (#3462). `rank` is a
    // small integer and `detectedAt` ties in bulk (one provider sync writes
    // every finding it pulled in a single transaction), so ordering on those
    // two alone leaves row order undefined between two LIMIT/OFFSET queries and
    // a client paging the feed would see some rows twice and miss others. There
    // is no single base-table PK here — the feed is a UNION ALL over three
    // sources — so we key on `(source, sourceId)`: `source` is a constant per
    // leg, and `sourceId` separates rows within a leg.
    //
    // Honest caveat: that pair is a COMPLETE key only for the tracked leg
    // (`incidents.id`). The EDR legs carry the vendor's own id, and its unique
    // index is per INTEGRATION (`huntress_incidents_external_idx` on
    // `(integration_id, huntress_incident_id)`; likewise for S1), while these
    // legs are scoped by `org_id` alone. An org with two integrations from the
    // same vendor could therefore still tie — which needs identical rank AND
    // identical detectedAt AND a colliding vendor incident id, so it is a
    // remote corner rather than the everyday transaction-timestamp tie this
    // fixes. Making it airtight means adding `integration_id` as a fourth
    // aliased column to all three legs; not worth the surface today, but that
    // is the fix if it ever bites.
    .orderBy(asc(sub.rank), desc(sub.detectedAt), asc(sub.source), asc(sub.sourceId))
    .limit(params.limit)
    .offset(params.offset);

  return { countQuery, rowsQuery };
}

export async function buildIncidentFeed(
  auth: AuthContext,
  params: IncidentFeedParams
): Promise<{ rows: IncidentFeedRow[]; total: number }> {
  const built = buildIncidentFeedQueries(auth, params);
  if (!built) return { rows: [], total: 0 };

  const [countRows, rows] = await Promise.all([built.countQuery, built.rowsQuery]);

  return {
    rows: rows.map((r) => {
      const source = r.source as IncidentFeedSource;
      return {
        kind: r.kind as 'tracked' | 'finding',
        source,
        sourceId: r.sourceId,
        title: r.title,
        severity: severityRankToLabel(Number(r.rank)),
        edrStatus: r.edrStatus,
        status: r.status,
        deviceId: r.deviceId,
        detectedAt: dateFromSqlValue(r.detectedAt as unknown as string).toISOString(),
        trackedIncidentId: r.trackedIncidentId,
        // EDR-framework rows carry no vendor deep link in W02 (details is NULL).
        linkOut: source === 'breeze' || isEdrProviderKey(source) ? null : resolveFindingLinkOut(r.details),
      };
    }),
    total: Number(countRows[0]?.count ?? 0),
  };
}
