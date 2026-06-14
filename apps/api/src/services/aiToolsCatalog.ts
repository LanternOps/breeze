/**
 * AI Catalog Tools
 *
 * Provides read-only AI tools over the partner product catalog:
 *  - `search_catalog`   — list/search active catalog items (hardware/software/service/bundle)
 *  - `get_catalog_item` — full detail for one item, plus bundle components if it is a bundle
 *
 * The catalog is partner-scoped (RLS shape 3). Every query is filtered by
 * `auth.partnerId`; a context without a partner gets an error string. Listing
 * is additionally filtered to `isActive` rows.
 */

import { and, asc, eq, ilike } from 'drizzle-orm';
import { db } from '../db';
import { catalogItems, catalogBundleComponents } from '../db/schema';
import type { AiTool, AiToolTier } from './aiTools';
import { escapeLikePattern } from './catalogService';

export function registerCatalogTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('search_catalog', {
    tier: 2 as AiToolTier,
    deviceArgs: [],
    definition: {
      name: 'search_catalog',
      description:
        'Search the partner product catalog (hardware, software, services, and bundles) by name or type. Read-only.',
      input_schema: {
        type: 'object' as const,
        properties: {
          search: { type: 'string', description: 'Name substring to match' },
          itemType: {
            type: 'string',
            enum: ['hardware', 'software', 'service'],
            description: 'Filter by item type'
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
      if (input.search) {
        conditions.push(ilike(catalogItems.name, `%${escapeLikePattern(String(input.search))}%`));
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
      if (!item.isBundle) {
        return JSON.stringify({ item });
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
      return JSON.stringify({ item, components });
    }
  });
}
