import { Hono } from 'hono';
import { zValidator } from '../lib/validation';
import { z } from 'zod';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db';
import { devices, manualAssets } from '../db/schema';
import { authMiddleware, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { PERMISSIONS, type UserPermissions } from '../services/permissions';

export const tagRoutes = new Hono();
const requireTagRead = requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action);

type TagSummary = {
  id: string;
  name: string;
  tag: string;
  deviceCount: number;
};

const listTagsQuerySchema = z.object({
  search: z.string().optional()
});

tagRoutes.use('*', authMiddleware);

async function getOrgIdsForAuth(
  auth: Pick<AuthContext, 'scope' | 'orgId' | 'accessibleOrgIds'>
): Promise<string[] | null> {
  if (auth.scope === 'organization') {
    if (!auth.orgId) return null;
    return [auth.orgId];
  }

  if (auth.scope === 'partner') {
    return auth.accessibleOrgIds ?? [];
  }

  return null;
}

/**
 * Manual assets (#4622) are a first-class class of the unified Devices list
 * (`deviceClass: 'manual'`), and carry their own `tags` column, so the tag
 * taxonomy has to aggregate them too (#5425).
 *
 * Scoping mirrors `routes/devices/manual.ts`'s `GET /devices/manual` so the tag
 * facets agree with the list they filter: org axis (RLS-backed, shape 1 direct
 * `org_id`), app-layer site allowlist on the site axis, and the same
 * retired/linked exclusions — a linked asset is already represented by its
 * device or discovered-asset row, so counting it again would double-count.
 */
function manualAssetConditions(
  orgIds: string[] | null,
  allowedSiteIds: string[] | undefined
): ReturnType<typeof eq>[] {
  const conditions = [
    isNull(manualAssets.retiredAt),
    isNull(manualAssets.linkedDeviceId),
    isNull(manualAssets.linkedDiscoveredAssetId)
  ] as ReturnType<typeof eq>[];

  if (orgIds) {
    conditions.push(inArray(manualAssets.orgId, orgIds));
  }

  if (allowedSiteIds) {
    conditions.push(allowedSiteIds.length > 0
      ? inArray(manualAssets.siteId, allowedSiteIds)
      : sql`false`);
  }

  return conditions;
}

// GET / - List all unique tags across devices in the org
tagRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  requireTagRead,
  zValidator('query', listTagsQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const orgIds = await getOrgIdsForAuth(auth);
    if (auth.scope !== 'system' && (!orgIds || orgIds.length === 0)) {
      return c.json({ data: [], total: 0 });
    }

    // Build the query to get all devices with their tags
    // Quick Support devices sit in the hidden 'quick_support' org that stays
    // inside accessibleOrgIds for RLS, so nothing drops them for us — tag
    // facet counts must exclude them explicitly.
    const conditions = [eq(devices.isEphemeral, false)] as ReturnType<typeof eq>[];
    if (orgIds) {
      conditions.push(inArray(devices.orgId, orgIds));
    }

    // Site-axis narrowing — RLS only enforces the org axis, so site-restricted
    // users must be narrowed app-layer. Mirror devices/core.ts: an empty
    // allowlist short-circuits to no rows; unset = full org access.
    const allowedSiteIds = (c.get('permissions') as UserPermissions | undefined)?.allowedSiteIds;
    if (allowedSiteIds) {
      conditions.push(allowedSiteIds.length > 0
        ? inArray(devices.siteId, allowedSiteIds)
        : sql`false`);
    }

    const whereCondition = conditions.length ? and(...conditions) : undefined;

    // Query all devices and their tags
    const deviceRows = await db
      .select({ tags: devices.tags })
      .from(devices)
      .where(whereCondition);

    const manualRows = await db
      .select({ tags: manualAssets.tags })
      .from(manualAssets)
      .where(and(...manualAssetConditions(orgIds, allowedSiteIds)));

    // Aggregate tags and count occurrences. `deviceCount` counts rows of the
    // unified Devices list, so manual assets add to the same counter.
    const tagCounts = new Map<string, number>();

    for (const row of [...deviceRows, ...manualRows]) {
      const tags = row.tags ?? [];
      for (const tag of tags) {
        if (typeof tag === 'string' && tag.trim()) {
          tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
        }
      }
    }

    // Convert to array and apply search filter
    let results: TagSummary[] = Array.from(tagCounts.entries())
      .map(([tag, deviceCount]) => ({
        id: tag,
        name: tag,
        tag,
        deviceCount
      }))
      .sort((a, b) => b.deviceCount - a.deviceCount || a.tag.localeCompare(b.tag));

    if (query.search) {
      const term = query.search.toLowerCase();
      results = results.filter((item) => item.tag.toLowerCase().includes(term));
    }

    return c.json({ data: results, total: results.length });
  }
);

// GET /devices - Get devices by tag
tagRoutes.get(
  '/devices',
  requireScope('organization', 'partner', 'system'),
  requireTagRead,
  zValidator('query', z.object({ tag: z.string().min(1) })),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const orgIds = await getOrgIdsForAuth(auth);
    if (auth.scope !== 'system' && (!orgIds || orgIds.length === 0)) {
      return c.json({ data: [], total: 0 });
    }

    // Ephemeral Quick Support devices are excluded from tag facets/listings.
    const conditions = [eq(devices.isEphemeral, false)] as ReturnType<typeof eq>[];
    if (orgIds) {
      conditions.push(inArray(devices.orgId, orgIds));
    }

    // Site-axis narrowing — RLS only enforces the org axis, so site-restricted
    // users must be narrowed app-layer. Mirror devices/core.ts: an empty
    // allowlist short-circuits to no rows; unset = full org access.
    const allowedSiteIds = (c.get('permissions') as UserPermissions | undefined)?.allowedSiteIds;
    if (allowedSiteIds) {
      conditions.push(allowedSiteIds.length > 0
        ? inArray(devices.siteId, allowedSiteIds)
        : sql`false`);
    }

    // Filter by tag - PostgreSQL array contains (use sql.param for safety)
    conditions.push(sql`${sql.param(query.tag)} = ANY(${devices.tags})`);

    const whereCondition = and(...conditions);

    const deviceRows = await db
      .select({
        id: devices.id,
        hostname: devices.hostname,
        displayName: devices.displayName,
        status: devices.status,
        osType: devices.osType,
        tags: devices.tags
      })
      .from(devices)
      .where(whereCondition);

    const manualRows = await db
      .select({
        id: manualAssets.id,
        name: manualAssets.name,
        tags: manualAssets.tags
      })
      .from(manualAssets)
      .where(and(
        ...manualAssetConditions(orgIds, allowedSiteIds),
        sql`${sql.param(query.tag)} = ANY(${manualAssets.tags})`
      ));

    const data = [
      ...deviceRows.map((d) => ({
        id: d.id,
        deviceClass: 'agent' as const,
        hostname: d.hostname,
        displayName: d.displayName,
        status: d.status,
        osType: d.osType,
        tags: d.tags ?? []
      })),
      // Same presentation shape `GET /devices/manual` uses: the asset name
      // stands in for hostname/displayName, status is 'unknown' (a manual asset
      // has no reachability), and every agent-only field is null.
      ...manualRows.map((m) => ({
        id: m.id,
        deviceClass: 'manual' as const,
        hostname: m.name,
        displayName: m.name,
        status: 'unknown' as const,
        osType: null,
        tags: m.tags ?? []
      }))
    ];

    return c.json({ data, total: data.length });
  }
);
