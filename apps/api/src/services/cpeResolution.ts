import { sql } from 'drizzle-orm';

import { db, withSystemDbAccessContext } from '../db';
import { softwareInventory, softwareProducts, softwareProductResolutions } from '../db/schema';
import {
  RESOLVER_VERSION, buildCatalogIndex, loadCuratedDictionary, resolve,
  type CatalogProduct, type ResolutionConfidence,
} from './cpeResolver';

/**
 * Global pass: resolve every distinct (lower(trim(name)), lower(trim(vendor))) in
 * software_inventory against the catalog and upsert into software_product_resolutions.
 *
 * Skip only rows that are already MATCHED (software_product_id NOT NULL) at the current
 * RESOLVER_VERSION. Unmatched rows (confidence='none', product NULL) are re-resolved every
 * cycle: the catalog `software_products` grows at runtime as NVD/MSRC feeds ingest,
 * independent of RESOLVER_VERSION, so an app first seen before its catalog product exists
 * must get another chance once that product lands — otherwise its CVEs would never surface
 * until a code redeploy. Rows from an older RESOLVER_VERSION are also re-resolved.
 * System context only — software_product_resolutions and the catalog are global
 * system-only tables.
 */
export async function refreshResolutionCache(): Promise<Record<ResolutionConfidence, number>> {
  const counts: Record<ResolutionConfidence, number> = { curated: 0, exact: 0, fuzzy: 0, none: 0 };

  await withSystemDbAccessContext(async () => {
    const products = await db
      .select({ id: softwareProducts.id, normalizedName: softwareProducts.normalizedName, normalizedVendor: softwareProducts.normalizedVendor, cpe: softwareProducts.cpe })
      .from(softwareProducts);
    const index = buildCatalogIndex(products as CatalogProduct[]);
    const curated = loadCuratedDictionary();

    // distinct SQL-reproducible keys, plus a representative original name for normalization
    const keys = await db
      .select({
        lookupName: sql<string>`lower(trim(${softwareInventory.name}))`,
        lookupVendor: sql<string | null>`lower(trim(${softwareInventory.vendor}))`,
        sampleName: sql<string>`min(${softwareInventory.name})`,
      })
      .from(softwareInventory)
      .groupBy(sql`lower(trim(${softwareInventory.name}))`, sql`lower(trim(${softwareInventory.vendor}))`);

    // Keys already MATCHED at the current version → settled, skip. Unmatched rows
    // (software_product_id NULL) are intentionally excluded so they re-resolve as the
    // catalog grows.
    const existing = await db
      .select({
        lookupName: softwareProductResolutions.lookupName,
        lookupVendor: softwareProductResolutions.lookupVendor,
        resolverVersion: softwareProductResolutions.resolverVersion,
        softwareProductId: softwareProductResolutions.softwareProductId,
      })
      .from(softwareProductResolutions);
    const settledKeys = new Set<string>();
    for (const e of existing) {
      if (e.resolverVersion === RESOLVER_VERSION && e.softwareProductId != null) {
        settledKeys.add(`${e.lookupName}\0${e.lookupVendor ?? ''}`);
      }
    }

    for (const k of keys) {
      const dedupeKey = `${k.lookupName}\0${k.lookupVendor ?? ''}`;
      if (settledKeys.has(dedupeKey)) continue;

      const r = resolve(k.sampleName, k.lookupVendor, index, curated);
      counts[r.confidence] += 1;

      await db
        .insert(softwareProductResolutions)
        .values({
          lookupName: k.lookupName,
          lookupVendor: k.lookupVendor,
          normalizedName: r.matchedVia === 'unmatched' ? k.lookupName : k.sampleName,
          softwareProductId: r.productId,
          confidence: r.confidence,
          matchedVia: r.matchedVia,
          resolverVersion: RESOLVER_VERSION,
          resolvedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [softwareProductResolutions.lookupName, softwareProductResolutions.lookupVendor],
          set: {
            softwareProductId: r.productId,
            confidence: r.confidence,
            matchedVia: r.matchedVia,
            resolverVersion: RESOLVER_VERSION,
            resolvedAt: new Date(),
          },
        });
    }
  });

  console.log('[cpeResolution] refresh complete', counts);
  return counts;
}
