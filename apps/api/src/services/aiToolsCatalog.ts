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
import { missingParamsJson, zodErrorToJson } from './aiToolValidation';

/**
 * Params each manage_catalog action requires, presence-checked BEFORE any
 * `String(...)` coercion so a missing id can't become the literal string
 * "undefined" and die downstream as an opaque uuid/DB 500 (#2362 sweep).
 */
const MANAGE_CATALOG_REQUIRED: Record<string, readonly string[]> = {
  create_item: ['item'],
  update_item: ['catalogId', 'item'],
  archive_item: ['catalogId'],
  set_org_price: ['catalogId', 'orgId', 'override'],
  remove_org_price: ['catalogId', 'orgId'],
  set_bundle_components: ['catalogId', 'components'],
};

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
 * Top-level catalog columns exposed to AI/MCP output. This is an ALLOWLIST, not
 * a blocklist: internal IDs (`partnerId`, `createdBy`) and any future column
 * added to `catalog_items` are dropped by construction — never leaked by
 * forgetting to strip them. `costBasis`/`markupPercent` are further redacted for
 * org-scoped callers (see AI_ITEM_ORG_REDACTED_FIELDS).
 */
const AI_ITEM_FIELDS = [
  'id',
  'name',
  'itemType',
  'sku',
  'description',
  'billingType',
  'billingFrequency',
  'commitmentTermMonths',
  'unitPrice',
  'costBasis',
  'markupPercent',
  'unitOfMeasure',
  'taxable',
  'taxCategory',
  'isBundle',
  'isActive',
  'createdAt',
  'updatedAt',
] as const satisfies readonly (keyof CatalogItemRow)[];

/**
 * Normalized distributor sub-fields kept from `attributes.distributor`. Also an
 * allowlist: the verbatim `raw` provider payload — and any future/unknown
 * distributor sub-field an importer might add — are dropped by construction.
 * `cost` is additionally redacted for org-scoped callers.
 */
const AI_DISTRIBUTOR_FIELDS = [
  'cost',
  'msrp',
  'warehouses',
  'mfgPartNo',
  'synnexSku',
  'status',
  'importedAt',
] as const;

/** Top-level cost/margin fields hidden from org-scoped (customer) callers. */
const AI_ITEM_ORG_REDACTED_FIELDS = ['costBasis', 'markupPercent'] as const;

function pickAllowed(src: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in src) out[key] = src[key];
  }
  return out;
}

/**
 * Shape a catalog row for AI/MCP output using explicit allowlists.
 *
 * - Top-level fields are projected via AI_ITEM_FIELDS, so internal IDs and any
 *   future column can never leak by omission (the reason this replaced the prior
 *   blocklist that named individual fields to strip).
 * - `attributes` is free-form jsonb: partner-authored keys pass through, but the
 *   `distributor` sub-object is rebuilt from AI_DISTRIBUTOR_FIELDS so the raw
 *   import blob and any future distributor sub-field are dropped.
 * - Cost/margin fields (`costBasis`, `markupPercent`, `distributor.cost`) are
 *   redacted for org-scoped callers. The catalog is partner-axis (RLS shape 3)
 *   and org-scoped tokens carry the owning org's partnerId (so they pass the
 *   partnerId gate) but get an RLS context without partner access, so the
 *   partner-scoped SELECT returns 0 rows today — effectively partner-only. This
 *   redaction is defense-in-depth so a future system-context execution path can
 *   never leak distributor cost / margin to a customer (org) token.
 */
function sanitizeCatalogItemForAi(item: CatalogItemRow, auth: AuthContext): Record<string, unknown> {
  const out = pickAllowed(item as unknown as Record<string, unknown>, AI_ITEM_FIELDS);

  const attrs = item.attributes;
  if (attrs && typeof attrs === 'object' && !Array.isArray(attrs)) {
    const attrsCopy: Record<string, unknown> = { ...(attrs as Record<string, unknown>) };
    const dist = attrsCopy.distributor;
    if (dist && typeof dist === 'object' && !Array.isArray(dist)) {
      attrsCopy.distributor = pickAllowed(dist as Record<string, unknown>, AI_DISTRIBUTOR_FIELDS);
    }
    out.attributes = attrsCopy;
  }

  if (auth.scope === 'organization') {
    for (const field of AI_ITEM_ORG_REDACTED_FIELDS) delete out[field];
    const outAttrs = out.attributes;
    if (outAttrs && typeof outAttrs === 'object' && !Array.isArray(outAttrs)) {
      const dist = (outAttrs as Record<string, unknown>).distributor;
      if (dist && typeof dist === 'object' && !Array.isArray(dist)) {
        delete (dist as Record<string, unknown>).cost;
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
      // Same org-scope defense-in-depth as the item's cost fields:
      // revenueAllocation is the partner's internal revenue split.
      const sanitizedComponents =
        auth.scope === 'organization'
          ? components.map(({ revenueAllocation: _ra, ...rest }) => rest)
          : components;
      return JSON.stringify({ item: sanitized, components: sanitizedComponents });
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

      const action = String(input.action);
      const required = MANAGE_CATALOG_REQUIRED[action];
      if (!required) {
        return JSON.stringify({ error: `Unknown action: ${action}`, code: 'VALIDATION_ERROR' });
      }
      const missing = missingParamsJson(input, action, required);
      if (missing) return missing;

      try {
        switch (action) {
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
            return JSON.stringify({ error: `Unknown action: ${action}`, code: 'VALIDATION_ERROR' });
        }
      } catch (err) {
        const json = serviceErrorToJson(err) ?? zodErrorToJson(err);
        if (json) return json;
        throw err;
      }
    },
  });
}
