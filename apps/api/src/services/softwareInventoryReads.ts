/**
 * Software inventory reads shared by routes/softwareInventory.ts and the AI
 * software tools: the "All Orgs" read scope, the policy-status badge map and
 * the list / name-search / per-title device queries. Moved verbatim from the
 * GET handlers. Each returns plain data, or `{ error, status }` for a refused
 * `?orgId=`.
 */
import { and, eq, inArray, sql, desc, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { db } from '../db';
import { devices, softwareInventory, softwarePolicies } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import type { UserPermissions } from './permissions';
import { escapeLike } from '../utils/sql';
import { matchesSoftwareRule, normalizeSoftwarePolicyRules } from './softwarePolicyService';
import { resolveSoftwarePoliciesForDevice, resolveSecurityAgentsLinkForDevice } from './featureConfigResolver';
import { notParkedDeviceCondition } from './unassignedPool/selectorPredicate';

// Bound the distinct-name search like the filter engine does: the picker fires
// one query per keystroke against a table that grows to millions of rows, so a
// transaction-local statement_timeout keeps a pathological match from pinning a
// worker. db.transaction inside the request's RLS context becomes a SAVEPOINT
// that inherits the tenant GUCs, so org-scoping (RLS) is preserved.
const NAME_SEARCH_TIMEOUT_MS = 1000;

// Read endpoints support "All Orgs": when no orgId is requested, scope to every
// org the caller can reach via auth.orgCondition() (returns undefined for system
// scope — no filter, RLS governs). A requested orgId must be accessible. Unlike
// resolveOrgId (used by the policy writes, which need a single target org), this
// never demands a single org, so partner/system callers can aggregate.
export type OrgReadScope =
  | { applyTo: (column: PgColumn) => SQL | undefined }
  | { error: string; status: 403 };

export function resolveOrgReadScope(auth: AuthContext, requestedOrgId?: string): OrgReadScope {
  if (requestedOrgId) {
    if (!auth.canAccessOrg(requestedOrgId)) {
      return { error: 'Access to this organization denied', status: 403 };
    }
    return { applyTo: (column) => eq(column, requestedOrgId) };
  }
  return { applyTo: (column) => auth.orgCondition(column) };
}

export type PolicyStatus = 'allowed' | 'blocked' | 'audit' | 'no_policy';

type InventoryAggregateRow = {
  name: string;
  vendor: string | null;
  device_count: string;
  first_seen: string | null;
  last_seen: string | null;
  version_data: Array<{ version: string | null; device_id: string; catalog_id?: string | null }> | null;
};

export async function getPolicyStatusMap(
  _auth: AuthContext,
  orgFilter: SQL | undefined,
  inventoryRows: InventoryAggregateRow[],
): Promise<Map<string, PolicyStatus>> {
  // RLS and the per-device resolver admit partner templates for org callers
  // as well as partner callers, while excluding unrelated organizations.
  const policies = await db.select({
    id: softwarePolicies.id, mode: softwarePolicies.mode, rules: softwarePolicies.rules,
    managedByLinkId: softwarePolicies.managedByLinkId,
  }).from(softwarePolicies).where(and(
    eq(softwarePolicies.isActive, true),
    orgFilter ? sql`(${orgFilter} OR ${softwarePolicies.orgId} IS NULL)` : undefined,
  ));
  const applicableByDevice = new Map<string, Set<string>>();
  if (policies.length > 0) {
    const deviceIds = [...new Set(inventoryRows.flatMap((row) => row.version_data?.map((entry) => entry.device_id) ?? []))];
    // Bound concurrent hierarchy reads for large inventory pages.
    for (let i = 0; i < deviceIds.length; i += 20) {
      await Promise.all(deviceIds.slice(i, i + 20).map(async (id) => {
        const applicable = new Set(await resolveSoftwarePoliciesForDevice(id));
        if (policies.some((policy) => policy.managedByLinkId)) {
          const security = await resolveSecurityAgentsLinkForDevice(id);
          for (const policy of policies) {
            if (security && policy.managedByLinkId === security.linkId) applicable.add(policy.id);
          }
        }
        applicableByDevice.set(id, applicable);
      }));
    }
  }
  const rank: Record<PolicyStatus, number> = { no_policy: 0, audit: 1, allowed: 2, blocked: 3 };
  const statusMap = new Map<string, PolicyStatus>();
  for (const row of inventoryRows) {
    const key = `${row.name.toLowerCase()}|${(row.vendor ?? '').toLowerCase()}`;
    let status: PolicyStatus = 'no_policy';
    for (const policy of policies) {
      const rules = normalizeSoftwarePolicyRules(policy.rules);
      const matches = (row.version_data ?? []).some((entry) =>
        applicableByDevice.get(entry.device_id)?.has(policy.id)
        && rules.software.some((rule) => matchesSoftwareRule({
          name: row.name, vendor: row.vendor, version: entry.version, catalogId: entry.catalog_id ?? null,
        }, rule)));
      if (!matches) continue;
      const next: PolicyStatus = policy.mode === 'blocklist' ? 'blocked' : policy.mode === 'allowlist' ? 'allowed' : 'audit';
      // Aggregate rows can span devices: any applying deny wins the badge,
      // independently of SQL row order and configuration-policy specificity.
      if (rank[next] > rank[status]) status = next;
    }
    statusMap.set(key, status);
  }
  return statusMap;
}


// ============================================
// Reads
// ============================================

type InventoryReadError = { error: string; status: 403 };

/** GET / — software titles aggregated across the caller's devices. */
export async function listInventory(params: {
  auth: AuthContext;
  perms: Pick<UserPermissions, 'allowedSiteIds'> | undefined;
  /** The explicitly requested org (`?orgId=`); omitted = every reachable org. */
  orgId?: string;
  search?: string;
  vendor?: string;
  limit: number;
  offset: number;
  sortBy: 'name' | 'vendor' | 'deviceCount' | 'lastSeen';
  sortOrder: 'asc' | 'desc';
}) {
  const { auth, perms, search, vendor, limit, offset, sortBy, sortOrder } = params;

  const orgScope = resolveOrgReadScope(auth, params.orgId);
  if ('error' in orgScope) {
    return { error: orgScope.error, status: orgScope.status } satisfies InventoryReadError;
  }

  // Ephemeral Quick Support devices live in the hidden Quick Support org that
  // deliberately stays inside accessibleOrgIds so RLS lets a tech reach their own
  // session — nothing drops them for us. Both aggregates below are raw SQL, but
  // each already INNER JOINs `devices` and interpolates this same `whereClause`,
  // so pushing the predicate here covers the count and the row query alike.
  const conditions: SQL[] = [eq(devices.isEphemeral, false), notParkedDeviceCondition()];
  const deviceOrgFilter = orgScope.applyTo(devices.orgId);
  if (deviceOrgFilter) conditions.push(deviceOrgFilter);
  if (perms?.allowedSiteIds) {
    if (perms.allowedSiteIds.length === 0) {
      return { data: [], pagination: { total: 0, limit, offset } };
    }
    conditions.push(inArray(devices.siteId, perms.allowedSiteIds));
  }

  if (search) {
    const escaped = search.replace(/[%_\\]/g, '\\$&');
    conditions.push(sql`LOWER(${softwareInventory.name}) LIKE LOWER(${'%' + escaped + '%'})`);
  }
  if (vendor) {
    const escaped = vendor.replace(/[%_\\]/g, '\\$&');
    conditions.push(sql`LOWER(COALESCE(${softwareInventory.vendor}, '')) LIKE LOWER(${'%' + escaped + '%'})`);
  }

  // System-scope "All Orgs" with no search/site filter leaves conditions empty;
  // fall back to TRUE so the raw-SQL WHERE clause stays valid (RLS still scopes).
  const whereClause = conditions.length > 0 ? and(...conditions) : sql`TRUE`;

  // Count total unique software entries
  const countResult = await db.execute(sql`
    SELECT COUNT(*) AS total FROM (
      SELECT 1
      FROM ${softwareInventory}
      INNER JOIN ${devices} ON ${softwareInventory.deviceId} = ${devices.id}
      WHERE ${whereClause}
      GROUP BY LOWER(${softwareInventory.name}), LOWER(COALESCE(${softwareInventory.vendor}, ''))
    ) sub
  `);
  const total = Number((countResult[0] as { total: string } | undefined)?.total ?? 0);

  // Sort mapping
  const sortColumn =
    sortBy === 'name' ? sql`MIN(${softwareInventory.name})` :
    sortBy === 'vendor' ? sql`MIN(${softwareInventory.vendor})` :
    sortBy === 'lastSeen' ? sql`MAX(${softwareInventory.lastSeen})` :
    sql`COUNT(DISTINCT ${softwareInventory.deviceId})`;

  const orderDir = sortOrder === 'asc' ? sql`ASC` : sql`DESC`;

  const rows = await db.execute(sql`
    SELECT
      MIN(${softwareInventory.name}) AS name,
      MIN(${softwareInventory.vendor}) AS vendor,
      COUNT(DISTINCT ${softwareInventory.deviceId}) AS device_count,
      MIN(${softwareInventory.lastSeen}) AS first_seen,
      MAX(${softwareInventory.lastSeen}) AS last_seen,
      jsonb_agg(DISTINCT jsonb_build_object('version', ${softwareInventory.version}, 'device_id', ${softwareInventory.deviceId}, 'catalog_id', ${softwareInventory.catalogId})) AS version_data
    FROM ${softwareInventory}
    INNER JOIN ${devices} ON ${softwareInventory.deviceId} = ${devices.id}
    WHERE ${whereClause}
    GROUP BY LOWER(${softwareInventory.name}), LOWER(COALESCE(${softwareInventory.vendor}, ''))
    ORDER BY ${sortColumn} ${orderDir}
    LIMIT ${limit} OFFSET ${offset}
  `);

  // Build policy status map
  const policyStatusMap = await getPolicyStatusMap(auth, orgScope.applyTo(softwarePolicies.orgId), rows as unknown as InventoryAggregateRow[]);

  // Process results
  const data = (rows as unknown as Array<{
    name: string;
    vendor: string | null;
    device_count: string;
    first_seen: string | null;
    last_seen: string | null;
    version_data: Array<{ version: string | null; device_id: string; catalog_id?: string | null }> | null;
  }>).map((row) => {
    // Collapse version_data into {version, count} pairs
    const versionCounts: Record<string, number> = {};
    const countedDeviceVersions = new Set<string>();
    if (row.version_data) {
      for (const entry of row.version_data) {
        const key = JSON.stringify([entry.device_id, entry.version]);
        if (countedDeviceVersions.has(key)) continue;
        countedDeviceVersions.add(key);
        const v = entry.version || 'Unknown';
        versionCounts[v] = (versionCounts[v] ?? 0) + 1;
      }
    }
    const versions = Object.entries(versionCounts)
      .map(([version, count]) => ({ version, count }))
      .sort((a, b) => b.count - a.count);

    // Check policy status
    const key = `${row.name.toLowerCase()}|${(row.vendor ?? '').toLowerCase()}`;
    const policyStatus: PolicyStatus = policyStatusMap.get(key) ?? 'no_policy';

    return {
      name: row.name,
      vendor: row.vendor,
      deviceCount: Number(row.device_count),
      versions,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      policyStatus,
    };
  });

  return { data, pagination: { total, limit, offset } };
}

/** GET /names — distinct software-name search (filter picker). */
export async function searchInventoryNames(params: {
  auth: AuthContext;
  perms: Pick<UserPermissions, 'allowedSiteIds'> | undefined;
  orgId?: string;
  q: string;
  limit: number;
}) {
  const { auth, perms, q, limit } = params;
  const pattern = `%${escapeLike(q)}%`;

  if (perms?.allowedSiteIds?.length === 0) {
    return { data: [] as string[] };
  }

  // Same org-axis resolution as the sibling read routes (`GET /` and the
  // observations route): honour an explicit `?orgId=` after an access check
  // instead of silently ignoring it and aggregating every reachable org.
  const orgScope = resolveOrgReadScope(auth, params.orgId);
  if ('error' in orgScope) return { error: orgScope.error, status: orgScope.status } satisfies InventoryReadError;

  const conditions: SQL[] = [
    eq(devices.isEphemeral, false), notParkedDeviceCondition(),
    sql`${softwareInventory.name} ILIKE ${pattern}`,
  ];
  const orgCondition = orgScope.applyTo(devices.orgId);
  if (orgCondition) conditions.push(orgCondition);
  if (perms?.allowedSiteIds) {
    conditions.push(inArray(devices.siteId, perms.allowedSiteIds));
  }
  const whereClause = and(...conditions);

  // Keep the authorization predicate inside the DISTINCT statement and before
  // ORDER/LIMIT. RLS protects the org axis on software_inventory, while the
  // current-device join enforces the app-layer site axis and excludes ephemeral
  // or stale/mismatched inventory rows from the picker.
  const rows = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('statement_timeout', ${`${NAME_SEARCH_TIMEOUT_MS}ms`}, true)`
    );
    return tx.execute(sql`
      SELECT DISTINCT ${softwareInventory.name} AS name
      FROM ${softwareInventory}
      INNER JOIN ${devices}
        ON ${softwareInventory.deviceId} = ${devices.id}
        AND ${softwareInventory.orgId} = ${devices.orgId}
      WHERE ${whereClause}
      ORDER BY ${softwareInventory.name}
      LIMIT ${limit}
    `);
  });

  const names = (rows as unknown as Array<{ name: string }>).map((row) => row.name);
  return { data: names };
}

/** GET /:name/devices — devices that carry one software title. */
export async function listInventoryDevices(params: {
  auth: AuthContext;
  perms: Pick<UserPermissions, 'allowedSiteIds'> | undefined;
  orgId?: string;
  softwareName: string;
  vendor?: string;
  limit: number;
  offset: number;
}) {
  const { auth, perms, softwareName, vendor, limit, offset } = params;

  const orgScope = resolveOrgReadScope(auth, params.orgId);
  if ('error' in orgScope) {
    return { error: orgScope.error, status: orgScope.status } satisfies InventoryReadError;
  }

  const conditions: SQL[] = [
    sql`LOWER(${softwareInventory.name}) = LOWER(${softwareName})`,
  ];
  const deviceOrgFilter = orgScope.applyTo(devices.orgId);
  if (deviceOrgFilter) conditions.push(deviceOrgFilter);
  if (perms?.allowedSiteIds) {
    if (perms.allowedSiteIds.length === 0) {
      return {
        data: [],
        pagination: { total: 0, limit, offset },
      };
    }
    conditions.push(inArray(devices.siteId, perms.allowedSiteIds));
  }

  if (vendor) {
    conditions.push(sql`LOWER(COALESCE(${softwareInventory.vendor}, '')) = LOWER(${vendor})`);
  }

  const whereClause = and(...conditions);

  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(softwareInventory)
    .innerJoin(devices, eq(softwareInventory.deviceId, devices.id))
    .where(whereClause);
  const total = Number(countResult[0]?.count ?? 0);

  const rows = await db
    .select({
      deviceId: devices.id,
      hostname: devices.hostname,
      osType: devices.osType,
      osVersion: devices.osVersion,
      version: softwareInventory.version,
      lastSeen: softwareInventory.lastSeen,
    })
    .from(softwareInventory)
    .innerJoin(devices, eq(softwareInventory.deviceId, devices.id))
    .where(whereClause)
    .orderBy(desc(softwareInventory.lastSeen), desc(softwareInventory.id))
    .limit(limit)
    .offset(offset);

  return {
    data: rows,
    pagination: { total, limit, offset },
  };
}
