import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, inArray, isNull, ilike, or, sql, desc, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import {
  discoveredAssets,
  snmpDevices,
  networkMonitors,
} from '../../db/schema';
import { authMiddleware, requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS, canAccessSite, type UserPermissions } from '../../services/permissions';
import { listNetworkDevicesSchema } from './schemas';

export const networkRoutes = new Hono();

networkRoutes.use('*', authMiddleware);

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
      .orderBy(desc(discoveredAssets.lastSeenAt))
      .limit(limit)
      .offset(offset);

    // Normalize into the shared unified-list projection. `deviceClass`
    // is the presentation discriminator; agent-only fields (cpu/ram,
    // agentVersion, osBuild) are null so the web table renders "—".
    const data = rows.map((r) => ({
      id: r.id,
      deviceClass: 'network' as const,
      assetType: r.assetType,
      orgId: r.orgId,
      siteId: r.siteId,
      // Name precedence: user label > hostname > IP, mirroring Discovery.
      hostname: r.label || r.hostname || (r.ipAddress ?? ''),
      displayName: r.label ?? null,
      status: r.isOnline ? ('online' as const) : ('offline' as const),
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
      // Agent-only fields, null for network devices.
      agentId: null,
      agentVersion: null,
      osType: null,
      osVersion: null,
      osBuild: null,
      architecture: null,
      cpuPercent: null,
      ramPercent: null,
      hardware: null,
      metrics: null,
    }));

    const pagination: { page: number; limit: number; total?: number } = { page, limit };
    if (total !== undefined) pagination.total = total;

    return c.json({ data, pagination });
  },
);
