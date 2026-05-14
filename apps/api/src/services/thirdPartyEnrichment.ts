import { db } from '../db';
import { thirdPartyPackageCatalog } from '../db/schema';

type CatalogEntry = Pick<
  typeof thirdPartyPackageCatalog.$inferSelect,
  'id' | 'source' | 'packageId' | 'vendor' | 'friendlyName' | 'category' | 'defaultSeverity'
>;

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: Map<string, CatalogEntry> | null = null;
let cacheLoadedAt = 0;
let inflight: Promise<void> | null = null;

function cacheKey(source: string, packageId: string): string {
  return `${source}::${packageId}`;
}

async function loadCache(): Promise<Map<string, CatalogEntry>> {
  const rows = await db.select({
    id: thirdPartyPackageCatalog.id,
    source: thirdPartyPackageCatalog.source,
    packageId: thirdPartyPackageCatalog.packageId,
    vendor: thirdPartyPackageCatalog.vendor,
    friendlyName: thirdPartyPackageCatalog.friendlyName,
    category: thirdPartyPackageCatalog.category,
    defaultSeverity: thirdPartyPackageCatalog.defaultSeverity,
  }).from(thirdPartyPackageCatalog);

  const map = new Map<string, CatalogEntry>();
  for (const row of rows) {
    map.set(cacheKey(row.source, row.packageId), row);
  }
  return map;
}

export async function primeCatalogCache(): Promise<void> {
  cache = await loadCache();
  cacheLoadedAt = Date.now();
}

// Call from catalog write endpoints after a successful mutation.
export function invalidateCatalogCache(): void {
  cache = null;
  cacheLoadedAt = 0;
}

async function getCache(): Promise<Map<string, CatalogEntry>> {
  if (!cache || Date.now() - cacheLoadedAt > CACHE_TTL_MS) {
    // Singleflight: if a load is already in flight, await it instead of
    // starting a second concurrent query.
    if (!inflight) {
      inflight = primeCatalogCache().finally(() => {
        inflight = null;
      });
    }
    await inflight;
  }
  return cache!;
}

export interface EnrichmentInput {
  source: string;
  packageId: string | null;
  title: string;
  vendor: string | null;
  severity: string | null;
  category?: string | null;
}

export interface EnrichmentOutput {
  title: string;
  vendor: string | null;
  severity: string | null;
  category: string | null;
  matchedCatalogId: string | null;
}

export async function enrichFromCatalog(input: EnrichmentInput): Promise<EnrichmentOutput> {
  if (input.source !== 'third_party' || !input.packageId) {
    return {
      title: input.title,
      vendor: input.vendor,
      severity: input.severity,
      category: input.category ?? null,
      matchedCatalogId: null,
    };
  }

  const map = await getCache();
  const hit = map.get(cacheKey(input.source, input.packageId));
  if (!hit) {
    return {
      title: input.title,
      vendor: input.vendor,
      severity: input.severity,
      category: input.category ?? null,
      matchedCatalogId: null,
    };
  }

  return {
    title: hit.friendlyName,
    vendor: hit.vendor,
    severity: input.severity && input.severity !== 'unknown' ? input.severity : hit.defaultSeverity,
    category: hit.category,
    matchedCatalogId: hit.id,
  };
}
