/**
 * EDR provider framework — the ONE read model over persisted EDR data (#8166 W02).
 *
 * Used by `GET /edr/detections`, `GET /edr/status` and the `list_edr_detections`
 * / `get_edr_status` AI tools, so the site rule and the coverage disclosure are
 * defined once.
 *
 * Coverage (spec D6): every read carries `coverage`. An empty detection list is
 * only "no threats" when coverage is complete; a stale, failed, never-synced or
 * unmapped tenant, a reauth-required connection, or no EDR coverage at all sets
 * `partial: true` with a Breeze-generated note (never vendor text — notes reach
 * AI output unfenced).
 *
 * RLS reality: `edr_connections` / `edr_tenants` are partner-axis tables an
 * organization token cannot read. Org-scope callers get coverage from the
 * org-visible tables (`edr_endpoints`, `edr_detections`) only, plus an explicit
 * "sync health is visible to partner users only" note (owner decision, W02).
 */
import { and, asc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type {
  EdrConnectionStatus,
  EdrCoverage,
  EdrDetectionDto,
  EdrDetectionStatus,
  EdrSeverity,
  EdrStatusProviderSummary,
  EdrStatusSummary,
  EdrSyncStatus,
  EdrVendorKind,
} from '@breeze/shared';
import { EDR_OPEN_DETECTION_STATUSES } from '@breeze/shared';
import { db } from '../../db';
import {
  devices,
  edrConnections,
  edrDetections,
  edrEndpoints,
  edrTenants,
  huntressAgents,
  s1Agents,
} from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import type { UserPermissions } from '../permissions';
import { edrProviderLabel } from './providerKeys';
import { edrSitePredicate, isSiteRestricted, type EdrSiteRestriction } from './readScope';

export const SYNC_HEALTH_PARTNER_ONLY_NOTE =
  'EDR sync health (stale, failed or unmapped vendor tenants) is visible to partner users only; '
  + 'this organization-scoped result cannot confirm that every tenant synced recently.';

const DEFAULT_DETECTION_INTERVAL_MINUTES = 60;

export class EdrReadError extends Error {
  constructor(public status: 400 | 403, message: string) {
    super(message);
  }
}

export interface EdrReadScope extends EdrSiteRestriction {
  auth: AuthContext;
}

/**
 * Resolve the caller's site restriction. A caller with `allowedSiteIds` is
 * restricted to devices in those sites (RLS still bounds the org axis).
 */
export async function resolveEdrReadScope(
  auth: AuthContext,
  perms: UserPermissions | undefined,
): Promise<EdrReadScope> {
  const allowedSiteIds = perms?.allowedSiteIds ?? null;
  if (!allowedSiteIds) return { auth, allowedDeviceIds: null, allowedSiteIds: null };
  const rows = allowedSiteIds.length === 0
    ? []
    : await db.select({ id: devices.id }).from(devices).where(inArray(devices.siteId, allowedSiteIds));
  return { auth, allowedDeviceIds: rows.map((r) => r.id), allowedSiteIds };
}

/** Org filter for an org-axis EDR column, honouring an explicit `orgId`. */
export function edrOrgCondition(auth: AuthContext, orgId: string | undefined, column: Parameters<AuthContext['orgCondition']>[0]): SQL | undefined {
  if (auth.scope === 'organization') {
    if (!auth.orgId) throw new EdrReadError(403, 'Organization context required');
    if (orgId && orgId !== auth.orgId) throw new EdrReadError(403, 'Access to this organization denied');
    return eq(column, auth.orgId);
  }
  if (orgId) {
    if (!auth.canAccessOrg(orgId)) throw new EdrReadError(403, 'Access to this organization denied');
    return eq(column, orgId);
  }
  return auth.orgCondition(column);
}

// ---------------------------------------------------------------------------
// Detections
// ---------------------------------------------------------------------------

export interface ListEdrDetectionsQuery {
  orgId?: string;
  deviceId?: string;
  /**
   * Exact-device restriction (a device-bound AI agent run, #6086): only rows
   * linked to one of these devices. Unlike the site rule it admits no
   * never-linked rows. An empty list matches nothing.
   */
  deviceIds?: string[];
  severity?: EdrSeverity[];
  /** `open` (default) = open/in_progress/unknown; `all` = every status. */
  status?: 'open' | 'all' | EdrDetectionStatus;
  provider?: string;
  limit: number;
  offset: number;
}

export const EDR_DETECTIONS_MAX_LIMIT = 200;

/** WHERE conditions for a detection read. Exported for the DB-less SQL tests. */
export function buildDetectionConditions(scope: EdrReadScope, q: ListEdrDetectionsQuery): SQL[] {
  const conds: SQL[] = [isNull(edrDetections.detachedAt)];
  const org = edrOrgCondition(scope.auth, q.orgId, edrDetections.orgId);
  if (org) conds.push(org);
  const site = edrSitePredicate(scope);
  if (site) conds.push(site);
  if (q.deviceId) conds.push(eq(edrDetections.breezeDeviceId, q.deviceId));
  if (q.deviceIds) {
    conds.push(q.deviceIds.length > 0 ? inArray(edrDetections.breezeDeviceId, q.deviceIds) : sql`false`);
  }
  if (q.severity && q.severity.length > 0) conds.push(inArray(edrDetections.severity, q.severity));
  const status = q.status ?? 'open';
  if (status === 'open') conds.push(inArray(edrDetections.status, [...EDR_OPEN_DETECTION_STATUSES]));
  else if (status !== 'all') conds.push(eq(edrDetections.status, status));
  if (q.provider) conds.push(eq(edrDetections.provider, q.provider));
  return conds;
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

export function buildListEdrDetectionsQuery(scope: EdrReadScope, q: ListEdrDetectionsQuery) {
  const where = and(...buildDetectionConditions(scope, q));
  const limit = Math.min(Math.max(1, q.limit), EDR_DETECTIONS_MAX_LIMIT);
  const rows = db
    .select({
      id: edrDetections.id,
      connectionId: edrDetections.connectionId,
      orgId: edrDetections.orgId,
      provider: edrDetections.provider,
      vendorDetectionId: edrDetections.vendorDetectionId,
      vendorKind: edrDetections.vendorKind,
      severity: edrDetections.severity,
      status: edrDetections.status,
      title: edrDetections.title,
      category: edrDetections.category,
      threatName: edrDetections.threatName,
      filePath: edrDetections.filePath,
      processName: edrDetections.processName,
      mitreTechniques: edrDetections.mitreTechniques,
      detectedAt: edrDetections.detectedAt,
      resolvedAt: edrDetections.resolvedAt,
      endpointId: edrDetections.endpointId,
      breezeDeviceId: edrDetections.breezeDeviceId,
      deviceDetachedAt: edrDetections.deviceDetachedAt,
      deviceName: devices.hostname,
      promotedIncidentId: sql<string | null>`(
        SELECT i.id::text FROM incidents i
        WHERE i.org_id = ${edrDetections.orgId}
          AND i.source_type = 'edr_detection'
          AND i.source_ref = ${edrDetections.id}::text
        LIMIT 1
      )`,
    })
    .from(edrDetections)
    .leftJoin(devices, eq(devices.id, edrDetections.breezeDeviceId))
    .where(where)
    .orderBy(sql`${edrDetections.detectedAt} DESC NULLS LAST`, asc(edrDetections.id))
    .limit(limit)
    .offset(Math.max(0, q.offset));
  const count = db.select({ n: sql<number>`count(*)::int` }).from(edrDetections).where(where);
  return { rows, count, limit };
}

export async function listEdrDetections(
  scope: EdrReadScope,
  q: ListEdrDetectionsQuery,
): Promise<{ rows: EdrDetectionDto[]; total: number; coverage: EdrCoverage }> {
  const built = buildListEdrDetectionsQuery(scope, q);
  const [rows, countRows, status] = await Promise.all([
    built.rows,
    built.count,
    getEdrStatus(scope, { orgId: q.orgId }),
  ]);
  const orgScope = scope.auth.scope === 'organization';
  return {
    rows: rows.map((r): EdrDetectionDto => ({
      id: r.id,
      ...(orgScope ? {} : { connectionId: r.connectionId }),
      orgId: r.orgId,
      provider: r.provider,
      providerLabel: edrProviderLabel(r.provider),
      vendorDetectionId: r.vendorDetectionId,
      vendorKind: r.vendorKind as EdrVendorKind,
      severity: r.severity as EdrSeverity,
      status: r.status as EdrDetectionStatus,
      title: r.title,
      category: r.category,
      threatName: r.threatName,
      filePath: r.filePath,
      processName: r.processName,
      mitreTechniques: r.mitreTechniques ?? [],
      detectedAt: iso(r.detectedAt),
      resolvedAt: iso(r.resolvedAt),
      endpointId: r.endpointId,
      breezeDeviceId: r.breezeDeviceId,
      deviceName: r.deviceName ?? null,
      detached: r.breezeDeviceId === null && r.deviceDetachedAt !== null,
      promotedIncidentId: r.promotedIncidentId ?? null,
    })),
    total: Number(countRows[0]?.n ?? 0),
    coverage: status.coverage,
  };
}

// ---------------------------------------------------------------------------
// Status + coverage
// ---------------------------------------------------------------------------

export interface CoverageConnection {
  id: string;
  provider: string;
  status: EdrConnectionStatus;
  lastDetectionSyncAt: Date | null;
  detectionIntervalMinutes: number | null;
}

export interface CoverageTenant {
  connectionId: string;
  orgId: string | null;
  lastDetectionSyncAt: Date | null;
  lastDetectionSyncStatus: EdrSyncStatus | null;
}

export interface CoverageEndpointAgg {
  provider: string;
  connectionId: string;
  orgId: string;
  endpoints: number;
  linkedEndpoints: number;
  unhealthyEndpoints: number;
}

export interface CoverageDetectionAgg {
  provider: string;
  connectionId: string;
  openDetections: number;
}

export interface CoverageInput {
  /** True for partner/system scope (tenant + connection state readable). */
  syncHealthVisible: boolean;
  connections: CoverageConnection[];
  tenants: CoverageTenant[];
  endpoints: CoverageEndpointAgg[];
  detections: CoverageDetectionAgg[];
  legacy: { sentinelOne: boolean; huntress: boolean };
  now: Date;
}

/**
 * PURE: provider rows + coverage disclosure. Every note is a fixed,
 * Breeze-authored sentence with counts only — no vendor-supplied names.
 */
export function buildEdrStatusSummary(input: CoverageInput): EdrStatusSummary {
  const notes: string[] = [];
  let partial = false;
  const providers: EdrStatusProviderSummary[] = [];

  const endpointsByKey = new Map<string, { endpoints: number; linked: number; unhealthy: number }>();
  const orgsWithEndpoints = new Set<string>();
  for (const e of input.endpoints) {
    const key = input.syncHealthVisible ? e.connectionId : e.provider;
    const acc = endpointsByKey.get(key) ?? { endpoints: 0, linked: 0, unhealthy: 0 };
    acc.endpoints += e.endpoints;
    acc.linked += e.linkedEndpoints;
    acc.unhealthy += e.unhealthyEndpoints;
    endpointsByKey.set(key, acc);
    if (e.endpoints > 0) orgsWithEndpoints.add(e.orgId);
  }
  const openByKey = new Map<string, number>();
  for (const d of input.detections) {
    const key = input.syncHealthVisible ? d.connectionId : d.provider;
    openByKey.set(key, (openByKey.get(key) ?? 0) + d.openDetections);
  }

  if (input.syncHealthVisible) {
    const orgsWithTenants = new Set<string>();
    let stale = 0, failed = 0, pending = 0, unmapped = 0, partialSync = 0, reauth = 0, errored = 0, noMapped = 0;
    for (const c of input.connections) {
      const tenants = input.tenants.filter((t) => t.connectionId === c.id);
      const mapped = tenants.filter((t) => t.orgId !== null);
      const staleCutoff = input.now.getTime()
        - 2 * (c.detectionIntervalMinutes ?? DEFAULT_DETECTION_INTERVAL_MINUTES) * 60_000;
      const cStale = mapped.filter((t) => t.lastDetectionSyncAt !== null && t.lastDetectionSyncAt.getTime() < staleCutoff).length;
      const cFailed = mapped.filter((t) => t.lastDetectionSyncStatus === 'error').length;
      const cPartial = mapped.filter((t) => t.lastDetectionSyncStatus === 'partial').length;
      const cPending = mapped.filter((t) => t.lastDetectionSyncAt === null).length;
      const cUnmapped = tenants.length - mapped.length;
      for (const t of mapped) orgsWithTenants.add(t.orgId!);
      stale += cStale; failed += cFailed; pending += cPending; unmapped += cUnmapped; partialSync += cPartial;
      if (mapped.length === 0) noMapped += 1;
      if (c.status === 'reauth_required') reauth += 1;
      if (c.status === 'error') errored += 1;
      const agg = endpointsByKey.get(c.id) ?? { endpoints: 0, linked: 0, unhealthy: 0 };
      providers.push({
        provider: c.provider,
        label: edrProviderLabel(c.provider),
        connectionId: c.id,
        connectionStatus: c.status,
        tenantsMapped: mapped.length,
        tenantsUnmapped: cUnmapped,
        tenantsStale: cStale,
        tenantsFailed: cFailed,
        tenantsPending: cPending,
        endpoints: agg.endpoints,
        linkedEndpoints: agg.linked,
        unhealthyEndpoints: agg.unhealthy,
        openDetections: openByKey.get(c.id) ?? 0,
        lastDetectionSyncAt: iso(c.lastDetectionSyncAt),
      });
    }
    if (input.connections.length === 0) {
      partial = true;
      notes.push('No active EDR provider connection covers this scope; an empty detection list is not evidence of no threats.');
    }
    if (reauth > 0) { partial = true; notes.push(`${reauth} EDR connection(s) need re-authentication; their detections are not being synced.`); }
    if (errored > 0) { partial = true; notes.push(`${errored} EDR connection(s) are in an error state.`); }
    if (failed > 0) { partial = true; notes.push(`${failed} mapped EDR tenant(s) failed their last detection sync.`); }
    if (partialSync > 0) { partial = true; notes.push(`${partialSync} mapped EDR tenant(s) completed their last detection sync only partially.`); }
    if (stale > 0) { partial = true; notes.push(`${stale} mapped EDR tenant(s) have not synced detections recently (older than twice the sync interval).`); }
    if (pending > 0) { partial = true; notes.push(`${pending} mapped EDR tenant(s) have not completed a first detection sync yet (pending).`); }
    if (noMapped > 0) { partial = true; notes.push(`${noMapped} EDR connection(s) have no vendor tenant mapped to an organization in this scope.`); }
    if (unmapped > 0) { partial = true; notes.push(`${unmapped} EDR vendor tenant(s) are not mapped to an organization; their detections are not synced.`); }
    return finish(orgsWithTenants.size);
  }

  // Organization scope: org-visible tables only.
  for (const [provider, agg] of endpointsByKey) {
    providers.push({
      provider,
      label: edrProviderLabel(provider),
      endpoints: agg.endpoints,
      linkedEndpoints: agg.linked,
      unhealthyEndpoints: agg.unhealthy,
      openDetections: openByKey.get(provider) ?? 0,
      lastDetectionSyncAt: null,
    });
  }
  for (const [provider, open] of openByKey) {
    if (endpointsByKey.has(provider)) continue;
    providers.push({
      provider, label: edrProviderLabel(provider), endpoints: 0, linkedEndpoints: 0,
      unhealthyEndpoints: 0, openDetections: open, lastDetectionSyncAt: null,
    });
  }
  if (orgsWithEndpoints.size === 0) {
    partial = true;
    notes.push('No EDR provider endpoints are visible for this organization; an empty detection list is not evidence of no threats.');
  }
  // Sync health is hidden from this caller, so completeness cannot be
  // confirmed: an organization-scope result is always partial.
  partial = true;
  notes.push(SYNC_HEALTH_PARTNER_ONLY_NOTE);
  return finish(orgsWithEndpoints.size);

  function finish(orgsWithEdr: number): EdrStatusSummary {
    if (input.legacy.sentinelOne) {
      notes.push('SentinelOne data for this scope comes from the SentinelOne integration; use get_s1_threats for it.');
    }
    if (input.legacy.huntress) {
      notes.push('Huntress data for this scope comes from the Huntress integration; use get_huntress_incidents for it.');
    }
    return { providers, coverage: { orgsWithEdr, partial, notes } };
  }
}

export async function getEdrStatus(scope: EdrReadScope, q: { orgId?: string }): Promise<EdrStatusSummary> {
  const auth = scope.auth;
  const syncHealthVisible = auth.scope === 'partner' || auth.scope === 'system';

  const endpointConds: SQL[] = [];
  const endpointOrg = edrOrgCondition(auth, q.orgId, edrEndpoints.orgId);
  if (endpointOrg) endpointConds.push(endpointOrg);
  if (isSiteRestricted(scope)) {
    const ids = scope.allowedDeviceIds ?? [];
    endpointConds.push(ids.length > 0
      ? (or(isNull(edrEndpoints.breezeDeviceId), inArray(edrEndpoints.breezeDeviceId, ids)) as SQL)
      : isNull(edrEndpoints.breezeDeviceId));
  }
  const detectionConds = buildDetectionConditions(scope, { orgId: q.orgId, status: 'open', limit: 1, offset: 0 });

  const legacyOrgS1 = edrOrgCondition(auth, q.orgId, s1Agents.orgId);
  const legacyOrgHuntress = edrOrgCondition(auth, q.orgId, huntressAgents.orgId);

  const [endpointRows, detectionRows, s1Row, huntressRow] = await Promise.all([
    db.select({
      provider: edrEndpoints.provider,
      connectionId: edrEndpoints.connectionId,
      orgId: edrEndpoints.orgId,
      endpoints: sql<number>`count(*)::int`,
      linkedEndpoints: sql<number>`count(${edrEndpoints.breezeDeviceId})::int`,
      unhealthyEndpoints: sql<number>`count(*) FILTER (WHERE ${edrEndpoints.health} IN ('unhealthy', 'degraded'))::int`,
    })
      .from(edrEndpoints)
      .where(endpointConds.length > 0 ? and(...endpointConds) : undefined)
      .groupBy(edrEndpoints.provider, edrEndpoints.connectionId, edrEndpoints.orgId),
    db.select({
      provider: edrDetections.provider,
      connectionId: edrDetections.connectionId,
      openDetections: sql<number>`count(*)::int`,
    })
      .from(edrDetections)
      .where(and(...detectionConds))
      .groupBy(edrDetections.provider, edrDetections.connectionId),
    db.select({ id: s1Agents.id }).from(s1Agents).where(legacyOrgS1).limit(1),
    db.select({ id: huntressAgents.id }).from(huntressAgents).where(legacyOrgHuntress).limit(1),
  ]);

  let connections: CoverageConnection[] = [];
  let tenants: CoverageTenant[] = [];
  if (syncHealthVisible) {
    // Partner-axis tables: RLS narrows connections/tenants to the caller's
    // partner(s). Mapped tenants are further narrowed to the orgs this caller
    // may reach; unmapped tenants carry no org and are counted per connection.
    const connRows = await db
      .select({
        id: edrConnections.id,
        provider: edrConnections.provider,
        status: edrConnections.status,
        lastDetectionSyncAt: edrConnections.lastDetectionSyncAt,
        effective: edrConnections.effectiveDetectionIntervalMinutes,
        requested: edrConnections.detectionIntervalMinutes,
      })
      .from(edrConnections)
      .where(eq(edrConnections.isActive, true))
      .orderBy(asc(edrConnections.createdAt));
    const tenantOrg = edrOrgCondition(auth, q.orgId, edrTenants.orgId);
    const tenantRows = connRows.length === 0 ? [] : await db
      .select({
        connectionId: edrTenants.connectionId,
        orgId: edrTenants.orgId,
        lastDetectionSyncAt: edrTenants.lastDetectionSyncAt,
        lastDetectionSyncStatus: edrTenants.lastDetectionSyncStatus,
      })
      .from(edrTenants)
      .where(and(
        inArray(edrTenants.connectionId, connRows.map((c) => c.id)),
        isNull(edrTenants.vendorMissingSince),
        tenantOrg ? (or(isNull(edrTenants.orgId), tenantOrg) as SQL) : undefined,
      ));
    // A specific-org query only reports the connections that reach that org.
    const relevant = q.orgId
      ? connRows.filter((c) => tenantRows.some((t) => t.connectionId === c.id && t.orgId === q.orgId)
        || endpointRows.some((e) => e.connectionId === c.id))
      : connRows;
    connections = relevant.map((c) => ({
      id: c.id,
      provider: c.provider,
      status: c.status as EdrConnectionStatus,
      lastDetectionSyncAt: c.lastDetectionSyncAt,
      detectionIntervalMinutes: c.effective ?? c.requested,
    }));
    const relevantIds = new Set(connections.map((c) => c.id));
    tenants = tenantRows
      .filter((t) => relevantIds.has(t.connectionId))
      .map((t) => ({
        connectionId: t.connectionId,
        orgId: t.orgId,
        lastDetectionSyncAt: t.lastDetectionSyncAt,
        lastDetectionSyncStatus: t.lastDetectionSyncStatus as EdrSyncStatus | null,
      }));
  }

  return buildEdrStatusSummary({
    syncHealthVisible,
    connections,
    tenants,
    endpoints: endpointRows.map((r) => ({ ...r, endpoints: Number(r.endpoints), linkedEndpoints: Number(r.linkedEndpoints), unhealthyEndpoints: Number(r.unhealthyEndpoints) })),
    detections: detectionRows.map((r) => ({ ...r, openDetections: Number(r.openDetections) })),
    legacy: { sentinelOne: s1Row.length > 0, huntress: huntressRow.length > 0 },
    now: new Date(),
  });
}

