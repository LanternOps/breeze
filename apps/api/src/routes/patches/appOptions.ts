import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { and, inArray, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { devices, devicePatches, organizations, patches, thirdPartyPackageCatalog } from '../../db/schema';
import { requirePermission, requireScope } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { APP_RULE_SOURCES, canonicalAppRuleKey, linuxPackageName } from '@breeze/shared';

// The patch sources an app rule can target (#9370 added 'linux').
const RULE_SOURCES = APP_RULE_SOURCES;

const appOptionsQuerySchema = z.object({
  search: z.string().max(255).optional(),
  orgId: z.string().guid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

type AppOption = {
  source: string;
  packageId: string;
  vendor: string | null;
  displayName: string;
  inCatalog: boolean;
};

// Linux patches carry the agent's `apt:`/`yum:` prefix; the rule names the
// bare package, which also folds the same package from apt and dnf hosts
// into one option.
function optionPackageId(source: string, packageId: string): string {
  return source === 'linux' ? linuxPackageName(packageId) : packageId;
}

export const appOptionsRoutes = new Hono();

// GET /patches/app-options - options for policy app rules, combining curated
// catalog rows with third-party applications and Linux packages observed in
// patch data.
appOptionsRoutes.get(
  '/app-options',
  requireScope('organization', 'partner', 'system'),
  // Same RBAC bar as every sibling patch read (list.ts, compliance.ts).
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('query', appOptionsQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const { search, orgId, limit } = c.req.valid('query');

    if (orgId && !auth.canAccessOrg(orgId)) {
      return c.json({ error: 'Access denied to this organization' }, 403);
    }

    // The `patches` table is global (no org_id column, no RLS — tenant
    // isolation lives on device_patches), so the observed query MUST always
    // be tenant-scoped for non-system callers. Never run it unconstrained
    // except for system scope: otherwise any authenticated user could
    // enumerate third-party software observed across ALL tenants.
    const observedConditions: SQL[] = [
      inArray(patches.source, [...RULE_SOURCES]),
      sql`${patches.packageId} IS NOT NULL`,
    ];

    if (orgId) {
      observedConditions.push(sql`EXISTS (
        SELECT 1 FROM ${devicePatches} dp
        INNER JOIN ${devices} d ON d.id = dp.device_id
        WHERE dp.patch_id = ${patches.id} AND d.org_id = ${orgId}
      )`);
    } else if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      observedConditions.push(sql`EXISTS (
        SELECT 1 FROM ${devicePatches} dp
        INNER JOIN ${devices} d ON d.id = dp.device_id
        WHERE dp.patch_id = ${patches.id} AND d.org_id = ${auth.orgId}
      )`);
    } else if (auth.scope === 'partner') {
      if (!auth.partnerId) {
        return c.json({ error: 'Partner context required' }, 403);
      }
      observedConditions.push(sql`EXISTS (
        SELECT 1 FROM ${devicePatches} dp
        INNER JOIN ${devices} d ON d.id = dp.device_id
        INNER JOIN ${organizations} o ON o.id = d.org_id
        WHERE dp.patch_id = ${patches.id} AND o.partner_id = ${auth.partnerId}
      )`);
    } else if (auth.scope !== 'system') {
      // Unknown scope — refuse rather than run the observed query unscoped.
      return c.json({ error: 'Insufficient permissions' }, 403);
    }

    // Curated catalog rows are intentionally global (not tenant data).
    const catalogRows = await db
      .select({
        source: thirdPartyPackageCatalog.source,
        packageId: thirdPartyPackageCatalog.packageId,
        vendor: thirdPartyPackageCatalog.vendor,
        displayName: thirdPartyPackageCatalog.friendlyName,
      })
      .from(thirdPartyPackageCatalog);

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
      const packageId = optionPackageId(row.source, row.packageId);
      if (!packageId) continue;
      merged.set(canonicalAppRuleKey(row.source, packageId), {
        source: row.source,
        packageId,
        vendor: row.vendor,
        displayName: row.displayName,
        inCatalog: false,
      });
    }

    for (const row of catalogRows) {
      merged.set(canonicalAppRuleKey(row.source, row.packageId), {
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

    // Applications first, then Linux packages: a Linux fleet reports hundreds
    // of upgradable packages, which would otherwise crowd applications off an
    // unsearched first page.
    const isLinux = (option: AppOption) => (option.source === 'linux' ? 1 : 0);
    options.sort((a, b) => isLinux(a) - isLinux(b) || a.displayName.localeCompare(b.displayName));

    return c.json({ data: options.slice(0, limit) });
  }
);
