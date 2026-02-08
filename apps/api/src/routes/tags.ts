import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { devices } from '../db/schema';
import { authMiddleware, requireScope, type AuthContext } from '../middleware/auth';

export const tagRoutes = new Hono();

type TagSummary = {
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

// GET / - List all unique tags across devices in the org
tagRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listTagsQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const orgIds = await getOrgIdsForAuth(auth);
    if (auth.scope !== 'system' && (!orgIds || orgIds.length === 0)) {
      return c.json({ data: [], total: 0 });
    }

    // Build the query to get all devices with their tags
    const conditions = [] as ReturnType<typeof eq>[];
    if (orgIds) {
      conditions.push(inArray(devices.orgId, orgIds));
    }

    const whereCondition = conditions.length ? and(...conditions) : undefined;

    // Query all devices and their tags
    const deviceRows = await db
      .select({ tags: devices.tags })
      .from(devices)
      .where(whereCondition);

    // Aggregate tags and count occurrences
    const tagCounts = new Map<string, number>();

    for (const row of deviceRows) {
      const tags = row.tags ?? [];
      for (const tag of tags) {
        if (typeof tag === 'string' && tag.trim()) {
          tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
        }
      }
    }

    // Convert to array and apply search filter
    let results: TagSummary[] = Array.from(tagCounts.entries())
      .map(([tag, deviceCount]) => ({ tag, deviceCount }))
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
  zValidator('query', z.object({ tag: z.string().min(1) })),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const orgIds = await getOrgIdsForAuth(auth);
    if (auth.scope !== 'system' && (!orgIds || orgIds.length === 0)) {
      return c.json({ data: [], total: 0 });
    }

    const conditions = [] as ReturnType<typeof eq>[];
    if (orgIds) {
      conditions.push(inArray(devices.orgId, orgIds));
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

    const data = deviceRows.map((d) => ({
      id: d.id,
      hostname: d.hostname,
      displayName: d.displayName,
      status: d.status,
      osType: d.osType,
      tags: d.tags ?? []
    }));

    return c.json({ data, total: data.length });
  }
);
