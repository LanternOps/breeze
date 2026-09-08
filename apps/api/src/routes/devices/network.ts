import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { and, eq, inArray, isNull, ilike, or, sql, desc, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import {
  discoveredAssets,
  snmpDevices,
  networkMonitors,
} from '../../db/schema';
import { authMiddleware, requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS, canAccessSite, type UserPermissions } from '../../services/permissions';
import { listNetworkDevicesSchema, createNetworkAssetSchema } from './schemas';

export const networkRoutes = new Hono();

networkRoutes.use('*', authMiddleware);

/** The row shape both the GET-arm select and the POST-arm insert `.returning()` share. */
interface UnifiedListSourceRow {
  id: string;
  orgId: string;
  siteId: string;
  assetType: string;
  hostname: string | null;
  label: string | null;
  ipAddress: string | null;
  macAddress: string | null;
  manufacturer: string | null;
  model: string | null;
  isOnline: boolean;
  responseTimeMs: number | null;
  openPorts: unknown;
  lastSeenAt: Date | null;
  firstSeenAt: Date;
  tags: string[] | null;
  source: string;
  url: string | null;
  snmpMonitoringEnabled?: boolean;
  networkMonitoringEnabled?: boolean;
}

/**
 * Normalizes a `discovered_assets` row into the shared unified-list shape
 * used by both handlers below (#5213 W02) — the create response must echo
 * exactly what the list arm renders, or a freshly-created row would flicker
 * to a different shape on the next GET.
 *
 * `deviceClass` is the presentation discriminator; agent-only fields
 * (cpu/ram, agentVersion, watchdogVersion, osBuild) are null so the web
 * table renders "—".
 */
function toUnifiedListShape(r: UnifiedListSourceRow) {
  return {
    id: r.id,
    deviceClass: 'network' as const,
    assetType: r.assetType,
    orgId: r.orgId,
    siteId: r.siteId,
    // Name precedence: user label > hostname > URL > IP. `url` (#5213) is the
    // only identity an IP-less website row has — without it in the chain a
    // url-only row would render an empty name.
    hostname: r.label || r.hostname || r.url || (r.ipAddress ?? ''),
    displayName: r.label ?? null,
    // A manual asset that no probe has ever reached is not "offline" — that
    // is a reachability claim we have not made. Matches the 'unknown' status
    // the #4622 manual-asset spec uses for the same situation.
    status: r.lastSeenAt === null && r.source === 'manual'
      ? ('unknown' as const)
      : r.isOnline ? ('online' as const) : ('offline' as const),
    ipAddress: r.ipAddress ?? null,
    macAddress: r.macAddress ?? null,
    manufacturer: r.manufacturer ?? null,
    model: r.model ?? null,
    responseTimeMs: r.responseTimeMs ?? null,
    openPorts: r.openPorts ?? null,
    lastSeenAt: r.lastSeenAt,
    enrolledAt: r.firstSeenAt,
    tags: r.tags ?? [],
    monitoringEnabled: Boolean(r.snmpMonitoringEnabled) || Boolean(r.networkMonitoringEnabled),
    snmpMonitoringEnabled: Boolean(r.snmpMonitoringEnabled),
    networkMonitoringEnabled: Boolean(r.networkMonitoringEnabled),
    // #5213 — provenance and the website/service identity.
    source: r.source,
    url: r.url ?? null,
    // Agent-only fields, null for network devices.
    agentId: null,
    agentVersion: null,
    watchdogVersion: null,
    osType: null,
    osVersion: null,
    osBuild: null,
    architecture: null,
    cpuPercent: null,
    ramPercent: null,
    hardware: null,
    metrics: null,
  };
}

/**
 * Resolves and enforces the org/site auth scope shared by both handlers
 * below — extracted so GET and POST can never drift on who is allowed to
 * see or write which org/site. Returns an error response to short-circuit
 * with, or `null` when the caller is in scope.
 */
function resolveAssetScope(
  auth: { canAccessOrg: (orgId: string) => boolean },
  permissions: UserPermissions | undefined,
  orgId: string,
  siteId: string,
): { error: string; status: 403 } | null {
  if (!auth.canAccessOrg(orgId)) {
    return { error: 'Access to this organization denied', status: 403 };
  }
  if (permissions?.allowedSiteIds && !canAccessSite(permissions, siteId)) {
    return { error: 'Access to this site denied', status: 403 };
  }
  return null;
}

/**
 * GET /devices/network — the "network" arm of the unified Devices list
 * (issue #1322, phase 1).
 *
 * Surfaces network-discovered assets (printers, routers, switches,
 * firewalls, NAS, cameras, IoT, …) that live in `discovered_assets`,
 * normalized into the same presentation shape the agent-device list uses,
 * tagged with `deviceClass: 'network'`. The web Devices list fetches this
 * alongside the agent `/devices` walk and merges them into one table with a
 * class/type badge and an All/Agent/Network filter.
 *
 * Inclusion rules (mirror the design in #1322):
 *   - `approval_status = 'approved'` only. `pending`/`dismissed` stay in the
 *     Discovery triage surface; they are not "managed" devices yet.
 *   - `linked_device_id IS NULL` only. A linked asset already has an enrolled
 *     agent row that wins in the unified list — including it here would
 *     double-count the same physical box.
 *
 * Tenant isolation: `discovered_assets` is a direct-`org_id` (shape #1) table
 * with FORCE ROW LEVEL SECURITY, so RLS already constrains every row to the
 * caller's accessible orgs. We additionally apply the same explicit
 * org/site auth narrowing the agent `/devices` endpoint uses so an
 * out-of-scope org/site filter is a 403 (not a silently-empty result), and
 * site-restricted users only ever see their allowed sites.
 *
 * Pagination: offset/limit. Keyset-cursor pagination *across the union* of
 * `devices` + `discovered_assets` (two tables, different sort keys) is the
 * known hard part called out in the issue's Open Questions. Phase 1 keeps
 * the two arms paginated independently — the agent arm keeps its keyset
 * cursor, the network arm uses simple offset paging — and the web layer
 * merges client-side. A unified keyset cursor is deferred to a follow-up.
 */
networkRoutes.get(
  '/network',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('query', listNetworkDevicesSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const limit = Math.min(1000, Math.max(1, Number.parseInt(query.limit ?? '500', 10) || 500));
    const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
    const offset = (page - 1) * limit;

    const conditions: SQL[] = [];

    // Org access — same accessible-org narrowing the agent list applies.
    const orgFilter = auth.orgCondition(discoveredAssets.orgId);
    if (orgFilter) {
      conditions.push(orgFilter);
    }

    // Optional single-org filter (must be accessible).
    if (query.orgId) {
      if (!auth.canAccessOrg(query.orgId)) {
        return c.json({ error: 'Access to this organization denied' }, 403);
      }
      conditions.push(eq(discoveredAssets.orgId, query.orgId));
    }

    if (query.orgIds && query.orgIds.length > 0) {
      for (const oid of query.orgIds) {
        if (!auth.canAccessOrg(oid)) {
          return c.json({ error: `Access to organization ${oid} denied` }, 403);
        }
      }
      conditions.push(inArray(discoveredAssets.orgId, query.orgIds));
    }

    // Site scoping — identical rules to the agent list so the two arms of
    // the unified view filter consistently (Open Question #7 in the issue).
    const permissions = c.get('permissions') as UserPermissions | undefined;
    const allowedSiteIds = permissions?.allowedSiteIds;
    const requestedSiteIds = [
      ...(query.siteId ? [query.siteId] : []),
      ...(query.siteIds ?? []),
    ];
    const uniqueRequestedSiteIds = [...new Set(requestedSiteIds)];

    if (allowedSiteIds) {
      const requestedOutsideAllowlist = uniqueRequestedSiteIds.find(
        (siteId) => !canAccessSite(permissions!, siteId),
      );
      if (requestedOutsideAllowlist) {
        return c.json({ error: 'Access to this site denied' }, 403);
      }
      const effectiveSiteIds = uniqueRequestedSiteIds.length > 0
        ? uniqueRequestedSiteIds
        : allowedSiteIds;
      conditions.push(effectiveSiteIds.length > 0
        ? inArray(discoveredAssets.siteId, effectiveSiteIds)
        : sql`false`);
    } else {
      if (query.siteId) {
        conditions.push(eq(discoveredAssets.siteId, query.siteId));
      }
      if (query.siteIds && query.siteIds.length > 0) {
        conditions.push(inArray(discoveredAssets.siteId, query.siteIds));
      }
    }

    // Only approved, unlinked assets are "managed" network devices.
    conditions.push(eq(discoveredAssets.approvalStatus, 'approved'));
    conditions.push(isNull(discoveredAssets.linkedDeviceId));

    if (query.assetType) {
      conditions.push(eq(discoveredAssets.assetType, query.assetType));
    }
    if (query.search) {
      const term = `%${query.search}%`;
      // Hostname or label match — host(ip) cast lets a partial IP search work
      // against the inet column without a full-text dependency.
      const searchPredicate = or(
        ilike(discoveredAssets.hostname, term),
        ilike(discoveredAssets.label, term),
        sql`host(${discoveredAssets.ipAddress}) ILIKE ${term}`,
      );
      if (searchPredicate) conditions.push(searchPredicate);
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    let total: number | undefined;
    if (query.includeTotal === 'true') {
      const countResult = await db
        .select({ count: sql<number>`count(*)` })
        .from(discoveredAssets)
        .where(whereCondition);
      total = Number(countResult[0]?.count ?? 0);
    }

    const rows = await db
      .select({
        id: discoveredAssets.id,
        orgId: discoveredAssets.orgId,
        siteId: discoveredAssets.siteId,
        assetType: discoveredAssets.assetType,
        hostname: discoveredAssets.hostname,
        label: discoveredAssets.label,
        ipAddress: discoveredAssets.ipAddress,
        macAddress: discoveredAssets.macAddress,
        manufacturer: discoveredAssets.manufacturer,
        model: discoveredAssets.model,
        isOnline: discoveredAssets.isOnline,
        responseTimeMs: discoveredAssets.responseTimeMs,
        openPorts: discoveredAssets.openPorts,
        lastSeenAt: discoveredAssets.lastSeenAt,
        firstSeenAt: discoveredAssets.firstSeenAt,
        tags: discoveredAssets.tags,
        // #5213 — provenance and the website/service identity, needed by
        // toUnifiedListShape's hostname precedence and status derivation.
        source: discoveredAssets.source,
        url: discoveredAssets.url,
        snmpMonitoringEnabled: sql<boolean>`exists (
          select 1 from ${snmpDevices}
          where ${snmpDevices.assetId} = ${discoveredAssets.id}
            and ${snmpDevices.orgId} = ${discoveredAssets.orgId}
            and ${snmpDevices.isActive} = true
        )`,
        networkMonitoringEnabled: sql<boolean>`exists (
          select 1 from ${networkMonitors}
          where ${networkMonitors.assetId} = ${discoveredAssets.id}
            and ${networkMonitors.orgId} = ${discoveredAssets.orgId}
            and ${networkMonitors.isActive} = true
        )`,
      })
      .from(discoveredAssets)
      .where(whereCondition)
      // `id` is a mandatory tiebreaker, not a cosmetic nicety (#3462).
      // A discovery sweep writes every asset it found in one transaction, so
      // `last_seen_at` ties in bulk. Ordering on a tied key alone leaves row
      // order undefined between two LIMIT/OFFSET queries, so the page walk in
      // `apps/web/src/lib/devicesFetch.ts` (`fetchAllNetworkDevices`) would
      // silently drop an asset and duplicate another.
      // COALESCE, not a bare column (#5213): Postgres sorts NULLs FIRST on
      // DESC, so a never-scanned manual row (last_seen_at NULL) would otherwise
      // pin to the top of page 1 of the offset walk in
      // apps/web/src/lib/devicesFetch.ts.
      .orderBy(
        desc(sql`coalesce(${discoveredAssets.lastSeenAt}, ${discoveredAssets.firstSeenAt})`),
        desc(discoveredAssets.id),
      )
      .limit(limit)
      .offset(offset);

    // Normalize into the shared unified-list projection (#5213 — shared with
    // the POST arm below via toUnifiedListShape, so a freshly-created row
    // and the same row's next GET can never render as different shapes).
    const data = rows.map((r) => toUnifiedListShape(r as UnifiedListSourceRow));

    const pagination: { page: number; limit: number; total?: number } = { page, limit };
    if (total !== undefined) pagination.total = total;

    return c.json({ data, pagination });
  },
);

/**
 * POST /devices/network — hand-enter a network asset (#5213 W02).
 *
 * A manual network asset IS a `discovered_assets` row — same table, same
 * consumers (monitors, SNMP, tunnels, the unified list, the partner
 * inventory API) as a scan-discovered one. It is born:
 *   - `approvalStatus: 'approved'` — a row a human typed has nothing to
 *     triage; it must never surface in the pending-approval queue.
 *   - `source: 'manual'`, `typeSource: 'manual'` — pins the type against
 *     every classifier and marks provenance so a later scan of the same
 *     IP updates the row in place instead of relabeling operator fields.
 *   - `isOnline: false`, `lastSeenAt: null` — NOT negotiable. The
 *     disappeared-sweep guard in discoveryWorker.ts keys on these staying
 *     false/NULL until a real scan actually sees the asset; setting either
 *     here would let a never-probed manual row falsely read as reachable.
 *
 * Reuses the same org/site auth narrowing as GET (site-scoped-tech gets a
 * 403 for a site outside their allowlist, same as the list arm).
 */
networkRoutes.post(
  '/network',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action),
  zValidator('json', createNetworkAssetSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');
    const permissions = c.get('permissions') as UserPermissions | undefined;

    const scopeError = resolveAssetScope(auth, permissions, body.orgId, body.siteId);
    if (scopeError) {
      return c.json({ error: scopeError.error }, scopeError.status);
    }

    try {
      const [row] = await db
        .insert(discoveredAssets)
        .values({
          orgId: body.orgId,
          siteId: body.siteId,
          label: body.label,
          assetType: body.assetType,
          ipAddress: body.ipAddress ?? null,
          hostname: body.hostname ?? null,
          url: body.url ?? null,
          macAddress: body.macAddress ?? null,
          manufacturer: body.manufacturer ?? null,
          model: body.model ?? null,
          notes: body.notes ?? null,
          tags: body.tags,
          source: 'manual',
          approvalStatus: 'approved',
          typeSource: 'manual',
          isOnline: false,
          lastSeenAt: null,
        })
        .returning();

      // Same shared shape GET returns (toUnifiedListShape derives 'unknown'
      // status itself from lastSeenAt===null && source==='manual', which is
      // exactly what this row was just born as).
      return c.json(toUnifiedListShape(row! as UnifiedListSourceRow), 201);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === '23505') {
        return c.json({ error: 'An asset with this IP already exists in this organization' }, 409);
      }
      if (code === '23514') {
        return c.json({ error: 'Provide at least one of: IP address, hostname, or URL' }, 400);
      }
      throw err;
    }
  },
);
