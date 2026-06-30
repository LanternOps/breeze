import { and, asc, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { unionAll } from 'drizzle-orm/pg-core';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { db } from '../db';
import { incidents, huntressIncidents, s1Threats, type IncidentTimelineEntry } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
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

export type IncidentFeedRow = {
  kind: 'tracked' | 'finding';
  source: 'breeze' | 'huntress' | 's1';
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

// Native p1..p4 enum -> same rank space.
function nativeSeverityRank(): SQL<number> {
  return sql<number>`CASE ${incidents.severity}
    WHEN 'p1' THEN 1 WHEN 'p2' THEN 2 WHEN 'p4' THEN 4 ELSE 3 END`;
}

export type IncidentFeedParams = {
  orgId?: string;
  kind?: 'tracked' | 'finding';
  source?: 'breeze' | 'huntress' | 's1';
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

  // Determine which legs to include based on filters. The raw EDR finding legs
  // require `devices:read`; a caller with only `alerts:read` (hasDevicesRead ===
  // false) gets native tracked incidents only. Fail-closed: only include EDR
  // when the caller explicitly signals devices:read. This composes with the
  // kind/source filters: a no-devices-read caller passing source=huntress simply
  // yields no legs → empty feed (null), not an error.
  const includeEdr = params.hasDevicesRead === true;
  const includeTracked = params.kind !== 'finding' && params.source !== 'huntress' && params.source !== 's1';
  const includeHuntress = includeEdr && params.kind !== 'tracked' && (params.source === undefined || params.source === 'huntress');
  const includeS1 = includeEdr && params.kind !== 'tracked' && (params.source === undefined || params.source === 's1');
  if (!includeTracked && !includeHuntress && !includeS1) return null;

  // Build UNION ALL explicitly per active combination so Drizzle can infer
  // each call's table-name union type (dynamic `legs[]` array spreads lose it).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const baseQ: any =
    includeTracked && includeHuntress && includeS1
      ? unionAll(trackedQ, huntressQ, s1Q)
      : includeHuntress && includeS1
        ? unionAll(huntressQ, s1Q)
        : includeTracked && includeHuntress
          ? unionAll(trackedQ, huntressQ)
          : includeTracked && includeS1
            ? unionAll(trackedQ, s1Q)
            : includeTracked
              ? trackedQ
              : includeHuntress
                ? huntressQ
                : s1Q;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  const sub = baseQ.as('feed');

  const countQuery = db.select({ count: sql<number>`count(*)` }).from(sub);
  const rowsQuery = db
    .select()
    .from(sub)
    // Order by the actual aliased subquery columns. `rank` ascending (p1
    // first), `detectedAt` descending. Referencing `sub.rank`/`sub.detectedAt`
    // emits correctly-quoted identifiers — raw unquoted `detected_at` would
    // fold to lowercase and fail (`column "detected_at" does not exist`).
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    .orderBy(asc(sub.rank), desc(sub.detectedAt))
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
      const source = r.source as 'breeze' | 'huntress' | 's1';
      return {
        kind: r.kind as 'tracked' | 'finding',
        source,
        sourceId: r.sourceId,
        title: r.title,
        severity: severityRankToLabel(Number(r.rank)),
        edrStatus: r.edrStatus,
        status: r.status,
        deviceId: r.deviceId,
        detectedAt: new Date(r.detectedAt as unknown as string).toISOString(),
        trackedIncidentId: r.trackedIncidentId,
        linkOut: source === 'breeze' ? null : resolveFindingLinkOut(r.details),
      };
    }),
    total: Number(countRows[0]?.count ?? 0),
  };
}
