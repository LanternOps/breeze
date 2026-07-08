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
 * Skips keys already resolved at the current RESOLVER_VERSION; re-resolves rows from an
 * older version (self-healing as the dictionary/catalog grows). System context only —
 * software_product_resolutions and the catalog are global system-only tables.
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

    // keys already resolved at the current version → skip
    const existing = await db
      .select({ lookupName: softwareProductResolutions.lookupName, lookupVendor: softwareProductResolutions.lookupVendor, resolverVersion: softwareProductResolutions.resolverVersion })
      .from(softwareProductResolutions);
    const currentByKey = new Map<string, number>();
    for (const e of existing) currentByKey.set(`${e.lookupName}\0${e.lookupVendor ?? ''}`, e.resolverVersion);

    for (const k of keys) {
      const dedupeKey = `${k.lookupName}\0${k.lookupVendor ?? ''}`;
      if (currentByKey.get(dedupeKey) === RESOLVER_VERSION) continue;

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
