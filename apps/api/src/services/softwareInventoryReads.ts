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

export async function getPolicyStatusMap(
  auth: AuthContext,
  orgFilter: SQL | undefined
): Promise<Map<string, PolicyStatus>> {
  const conditions: SQL[] = [eq(softwarePolicies.isActive, true)];
  // Dual-axis (#2126): software policies can be partner-wide templates
  // (org_id NULL). Those govern every org under the partner, so the badge
  // must include them — otherwise titles blocked by a partner-wide blocklist
  // render as no_policy. Partner-scope callers only; RLS hides partner rows
  // from org-scope tokens regardless.
  if (orgFilter) {
    conditions.push(
      auth.scope === 'partner' && auth.partnerId
        ? (sql`(${orgFilter} OR (${softwarePolicies.orgId} IS NULL AND ${softwarePolicies.partnerId} = ${auth.partnerId}))` as SQL)
        : orgFilter
    );
  }
  const policies = await db
    .select({
      mode: softwarePolicies.mode,
      rules: softwarePolicies.rules,
      isActive: softwarePolicies.isActive,
    })
    .from(softwarePolicies)
    .where(and(...conditions));

  // Keyed by name|vendor with no org dimension. In an "All Orgs" aggregate this
  // collapses policies from every accessible org onto one row; if two orgs hold
  // conflicting policies for the same software the badge is last-write-wins. This
  // is a display approximation on an org-collapsed row, never a cross-tenant read
  // (RLS still scopes the policies query to accessible orgs).
  const statusMap = new Map<string, PolicyStatus>();

  for (const policy of policies) {
    const rules = policy.rules as { software?: Array<{ name: string; vendor?: string }> } | null;
    if (!rules?.software) continue;

    for (const rule of rules.software) {
      const key = `${rule.name.toLowerCase()}|${(rule.vendor ?? '').toLowerCase()}`;
      const status: PolicyStatus =
        policy.mode === 'allowlist' ? 'allowed' :
        policy.mode === 'blocklist' ? 'blocked' : 'audit';
      statusMap.set(key, status);
    }
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
      jsonb_agg(DISTINCT jsonb_build_object('version', ${softwareInventory.version}, 'device_id', ${softwareInventory.deviceId}))
        FILTER (WHERE ${softwareInventory.version} IS NOT NULL) AS version_data
    FROM ${softwareInventory}
    INNER JOIN ${devices} ON ${softwareInventory.deviceId} = ${devices.id}
    WHERE ${whereClause}
    GROUP BY LOWER(${softwareInventory.name}), LOWER(COALESCE(${softwareInventory.vendor}, ''))
    ORDER BY ${sortColumn} ${orderDir}
    LIMIT ${limit} OFFSET ${offset}
  `);

  // Build policy status map
  const policyStatusMap = await getPolicyStatusMap(auth, orgScope.applyTo(softwarePolicies.orgId));

  // Process results
  const data = (rows as unknown as Array<{
    name: string;
    vendor: string | null;
    device_count: string;
    first_seen: string | null;
    last_seen: string | null;
    version_data: Array<{ version: string; device_id: string }> | null;
  }>).map((row) => {
    // Collapse version_data into {version, count} pairs
    const versionCounts: Record<string, number> = {};
    if (row.version_data) {
      for (const entry of row.version_data) {
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
