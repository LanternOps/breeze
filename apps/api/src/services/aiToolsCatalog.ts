/**
 * AI Catalog Tools
 *
 * Provides AI tools over the partner product catalog:
 *  - `search_catalog`   — list/search active catalog items (hardware/software/service/bundle)
 *  - `get_catalog_item` — full detail for one item, plus bundle components if it is a bundle
 *  - `manage_catalog`   — create/update/archive items, bundle components, and org price overrides
 *
 * The catalog is partner-scoped (RLS shape 3). Every query is filtered by
 * `auth.partnerId`; a context without a partner gets an error string. Listing
 * is additionally filtered to `isActive` rows.
 */

import { and, asc, eq, ilike, or, sql } from 'drizzle-orm';
import type {
  BundleComponentInput,
  CreateCatalogItemInput,
  OrgPriceOverrideInput,
  UpdateCatalogItemInput
} from '@breeze/shared';
import { db } from '../db';
import { catalogItems, catalogBundleComponents } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import type { AiTool, AiToolTier } from './aiTools';
import {
  archiveCatalogItem,
  CatalogServiceError,
  createCatalogItem,
  escapeLikePattern,
  removeOrgPriceOverride,
  setBundleComponents,
  setOrgPriceOverride,
  updateCatalogItem,
  type CatalogActor
} from './catalogService';

function actorFromAuth(auth: AuthContext): CatalogActor {
  return {
    userId: auth.user.id,
    partnerId: auth.partnerId ?? null,
    accessibleOrgIds: auth.accessibleOrgIds
  };
}

function serviceErrorToJson(err: unknown): string | null {
  if (err instanceof CatalogServiceError) {
    return JSON.stringify({ error: err.message, code: err.code });
  }
  return null;
}

type CatalogItemRow = typeof catalogItems.$inferSelect;

/**
 * Shape a catalog row for AI/MCP output.
 *
 * - Drops internal IDs (`partnerId`, `createdBy`): the MCP server instructions
 *   tell the model never to reveal internal IDs — redaction belongs server-side,
 *   not in model discipline.
 * - Strips `attributes.distributor.raw`, the verbatim provider payload kept for
 *   import traceability. It is a near-duplicate of the normalized distributor
 *   fields (cost/msrp/warehouses/…), blows the MCP output depth limiter
 *   ("[truncated: max depth reached]" noise), and roughly doubles tokens. The
 *   normalized fields (cost, msrp, warehouses, mfgPartNo, synnexSku, status,
 *   importedAt, …) are kept.
 * - Redacts cost/margin fields (`costBasis`, `markupPercent`,
 *   `attributes.distributor.cost`) for org-scoped callers. Note the catalog is
 *   partner-axis (RLS shape 3) and org-scoped tokens carry the owning org's
 *   partnerId (so they pass the partnerId gate) but get an RLS context without
 *   partner access, so the partner-scoped SELECT returns 0 rows today —
 *   effectively partner-only. This redaction is defense-in-depth so a future
 *   system-context execution path can never leak distributor cost / margin to a
 *   customer (org) token.
 */
function sanitizeCatalogItemForAi(item: CatalogItemRow, auth: AuthContext): Record<string, unknown> {
  const { partnerId: _partnerId, createdBy: _createdBy, ...rest } = item;
  const out: Record<string, unknown> = { ...rest };

  const attrs = item.attributes;
  if (attrs && typeof attrs === 'object' && !Array.isArray(attrs)) {
    const attrsCopy: Record<string, unknown> = { ...(attrs as Record<string, unknown>) };
    const dist = attrsCopy.distributor;
    if (dist && typeof dist === 'object' && !Array.isArray(dist)) {
      const { raw: _raw, ...distRest } = dist as Record<string, unknown>;
      attrsCopy.distributor = distRest;
    }
    out.attributes = attrsCopy;
  }

  if (auth.scope === 'organization') {
    delete out.costBasis;
    delete out.markupPercent;
    const outAttrs = out.attributes;
    if (outAttrs && typeof outAttrs === 'object' && !Array.isArray(outAttrs)) {
      const dist = (outAttrs as Record<string, unknown>).distributor;
      if (dist && typeof dist === 'object' && !Array.isArray(dist)) {
        const { cost: _cost, ...distRest } = dist as Record<string, unknown>;
        (outAttrs as Record<string, unknown>).distributor = distRest;
      }
    }
  }

  return out;
}

export function registerCatalogTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('search_catalog', {
    tier: 2 as AiToolTier,
    deviceArgs: [],
    definition: {
      name: 'search_catalog',
      description:
        'Search the partner product catalog (hardware, software, services, and bundles). The search term matches item name, SKU, and distributor part numbers (manufacturer part number / SYNNEX SKU). Optional filters: item type, bundle flag. Read-only.',
      input_schema: {
        type: 'object' as const,
        properties: {
          search: {
            type: 'string',
            description: 'Substring to match against item name, SKU, or distributor part number (mfgPartNo / synnexSku)'
          },
          itemType: {
            type: 'string',
            enum: ['hardware', 'software', 'service'],
            description: 'Filter by item type'
          },
          isBundle: {
            type: 'boolean',
            description: 'Filter to bundles only (true) or non-bundles only (false)'
          },
          limit: { type: 'number', description: 'Max results (default 25, max 100)' }
        },
        required: []
      }
    },
    handler: async (input, auth) => {
      const partnerId = auth.partnerId;
      if (!partnerId) {
        return JSON.stringify({ error: 'Catalog is partner-scoped; no partner in context' });
      }
      const conditions = [eq(catalogItems.partnerId, partnerId), eq(catalogItems.isActive, true)];
      if (input.itemType) {
        conditions.push(
          eq(catalogItems.itemType, input.itemType as 'hardware' | 'software' | 'service')
        );
      }
      if (typeof input.isBundle === 'boolean') {
        conditions.push(eq(catalogItems.isBundle, input.isBundle));
      }
      if (input.search) {
        const pattern = `%${escapeLikePattern(String(input.search))}%`;
        // Match name, the item's own SKU, and the normalized distributor part
        // numbers stored on imported items (attributes.distributor.mfgPartNo /
        // .synnexSku) — "find the item for SKU 14703953" is a natural quoting ask.
        const searchCondition = or(
          ilike(catalogItems.name, pattern),
          ilike(catalogItems.sku, pattern),
          sql`${catalogItems.attributes} -> 'distributor' ->> 'mfgPartNo' ILIKE ${pattern}`,
          sql`${catalogItems.attributes} -> 'distributor' ->> 'synnexSku' ILIKE ${pattern}`
        );
        if (searchCondition) conditions.push(searchCondition);
      }
      const limit = Math.min(Math.max(1, Number(input.limit) || 25), 100);
      const rows = await db
        .select({
          id: catalogItems.id,
          name: catalogItems.name,
          itemType: catalogItems.itemType,
          sku: catalogItems.sku,
          unitPrice: catalogItems.unitPrice,
          isBundle: catalogItems.isBundle
        })
        .from(catalogItems)
        .where(and(...conditions))
        .orderBy(asc(catalogItems.name))
        .limit(limit);
      return JSON.stringify({ items: rows, showing: rows.length });
    }
  });

  aiTools.set('get_catalog_item', {
    tier: 2 as AiToolTier,
    deviceArgs: [],
    definition: {
      name: 'get_catalog_item',
      description:
        'Get full detail for one catalog item by id, including bundle components if it is a bundle. Read-only.',
      input_schema: {
        type: 'object' as const,
        properties: {
          catalogItemId: { type: 'string', description: 'Catalog item UUID' }
        },
        required: ['catalogItemId']
      }
    },
    handler: async (input, auth) => {
      const partnerId = auth.partnerId;
      if (!partnerId) {
        return JSON.stringify({ error: 'Catalog is partner-scoped; no partner in context' });
      }
      const rows = await db
        .select()
        .from(catalogItems)
        .where(
          and(
            eq(catalogItems.id, String(input.catalogItemId)),
            eq(catalogItems.partnerId, partnerId)
          )
        )
        .limit(1);
      const item = rows[0];
      if (!item) {
        return JSON.stringify({ error: 'Catalog item not found' });
      }
      const sanitized = sanitizeCatalogItemForAi(item, auth);
      if (!item.isBundle) {
        return JSON.stringify({ item: sanitized });
      }
      const components = await db
        .select({
          id: catalogBundleComponents.id,
          componentItemId: catalogBundleComponents.componentItemId,
          quantity: catalogBundleComponents.quantity,
          showOnInvoice: catalogBundleComponents.showOnInvoice,
          revenueAllocation: catalogBundleComponents.revenueAllocation
        })
        .from(catalogBundleComponents)
        .where(
          and(
            eq(catalogBundleComponents.bundleItemId, item.id),
            eq(catalogBundleComponents.partnerId, partnerId)
          )
        );
      return JSON.stringify({ item: sanitized, components });
    }
  });

  aiTools.set('manage_catalog', {
    tier: 2 as AiToolTier,
    deviceArgs: [],
    definition: {
      name: 'manage_catalog',
      description:
        'Create and manage partner catalog items, organization price overrides, and bundle components.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: [
              'create_item',
              'update_item',
              'archive_item',
              'set_org_price',
              'remove_org_price',
              'set_bundle_components',
            ],
          },
          catalogId: { type: 'string', description: 'Catalog item UUID' },
          orgId: { type: 'string', description: 'Organization UUID for org-specific pricing' },
          item: { type: 'object', description: 'Catalog item create input or update patch' },
          override: { type: 'object', description: 'Organization price override fields' },
          components: {
            type: 'array',
            description: 'Bundle component rows for set_bundle_components',
            items: { type: 'object' as const },
          },
        },
        required: ['action'],
      },
    },
    handler: async (input, auth) => {
      const actor = actorFromAuth(auth);
      const s = (k: string) => (input[k] == null ? undefined : String(input[k]));

      try {
        switch (input.action) {
          case 'create_item':
            return JSON.stringify(await createCatalogItem(input.item as CreateCatalogItemInput, actor));
          case 'update_item':
            return JSON.stringify(await updateCatalogItem(
              String(input.catalogId),
              input.item as UpdateCatalogItemInput,
              actor
            ));
          case 'archive_item':
            return JSON.stringify(await archiveCatalogItem(String(input.catalogId), actor));
          case 'set_org_price':
            return JSON.stringify(await setOrgPriceOverride(
              String(input.catalogId),
              String(input.orgId),
              input.override as OrgPriceOverrideInput,
              actor
            ));
          case 'remove_org_price':
            return JSON.stringify(await removeOrgPriceOverride(
              String(input.catalogId),
              String(input.orgId),
              actor
            ));
          case 'set_bundle_components':
            return JSON.stringify(await setBundleComponents(
              String(input.catalogId),
              (input.components ?? []) as BundleComponentInput[],
              actor
            ));
          default:
            return JSON.stringify({ error: `Unknown action: ${s('action')}` });
        }
      } catch (err) {
        const json = serviceErrorToJson(err);
        if (json) return json;
        throw err;
      }
    },
  });
}
