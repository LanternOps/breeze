import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, inArray, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { devices, devicePatches, patches, thirdPartyPackageCatalog } from '../../db/schema';
import { requireScope } from '../../middleware/auth';

const THIRD_PARTY_SOURCES = ['third_party', 'custom'] as const;

const appOptionsQuerySchema = z.object({
  search: z.string().max(255).optional(),
  orgId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

type AppOption = {
  source: string;
  packageId: string;
  vendor: string | null;
  displayName: string;
  inCatalog: boolean;
};

export const appOptionsRoutes = new Hono();

// GET /patches/app-options - options for policy app rules, combining curated
// catalog rows with third-party applications observed in patch data.
appOptionsRoutes.get(
  '/app-options',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', appOptionsQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const { search, orgId, limit } = c.req.valid('query');

    if (orgId && !auth.canAccessOrg(orgId)) {
      return c.json({ error: 'Access denied to this organization' }, 403);
    }

    const catalogRows = await db
      .select({
        source: thirdPartyPackageCatalog.source,
        packageId: thirdPartyPackageCatalog.packageId,
        vendor: thirdPartyPackageCatalog.vendor,
        displayName: thirdPartyPackageCatalog.friendlyName,
      })
      .from(thirdPartyPackageCatalog);

    const observedConditions: SQL[] = [
      inArray(patches.source, [...THIRD_PARTY_SOURCES]),
      sql`${patches.packageId} IS NOT NULL`,
    ];

    if (orgId) {
      observedConditions.push(sql`EXISTS (
        SELECT 1 FROM ${devicePatches} dp
        INNER JOIN ${devices} d ON d.id = dp.device_id
        WHERE dp.patch_id = ${patches.id} AND d.org_id = ${orgId}
      )`);
    }

    const observedRows = await db
      .selectDistinct({
        source: patches.source,
        packageId: patches.packageId,
        vendor: patches.vendor,
        displayName: patches.title,
      })
      .from(patches)
      .where(and(...observedConditions));

    const merged = new Map<string, AppOption>();

    for (const row of observedRows) {
      if (!row.packageId) continue;
      merged.set(`${row.source}|${row.packageId.toLowerCase()}`, {
        source: row.source,
        packageId: row.packageId,
        vendor: row.vendor,
        displayName: row.displayName,
        inCatalog: false,
      });
    }

    for (const row of catalogRows) {
      merged.set(`${row.source}|${row.packageId.toLowerCase()}`, {
        source: row.source,
        packageId: row.packageId,
        vendor: row.vendor,
        displayName: row.displayName,
        inCatalog: true,
      });
    }

    let options = [...merged.values()];
    if (search) {
      const query = search.toLowerCase();
      options = options.filter((option) =>
        option.displayName.toLowerCase().includes(query) ||
        (option.vendor ?? '').toLowerCase().includes(query) ||
        option.packageId.toLowerCase().includes(query)
      );
    }

    options.sort((a, b) => a.displayName.localeCompare(b.displayName));

    return c.json({ data: options.slice(0, limit) });
  }
);
