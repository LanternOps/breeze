import type { PostureProduct, PostureProductCategory } from '@breeze/shared';

export type SecurityProductEvidence = Omit<PostureProduct, 'deviceCoverage'> & {
  deviceIds?: Iterable<string>;
};

const PROVIDER_NAMES: Record<string, string> = {
  windows_defender: 'Defender',
  sentinelone: 'SentinelOne',
  crowdstrike: 'CrowdStrike',
  bitdefender: 'Bitdefender',
  sophos: 'Sophos',
  malwarebytes: 'Malwarebytes',
  eset: 'ESET',
  kaspersky: 'Kaspersky',
  elastic_defend: 'Elastic Defend',
};

const EDR_PROVIDERS = new Set(['sentinelone', 'crowdstrike', 'elastic_defend']);
// Keyed by the union rather than an array: indexOf() on a missing member returns
// -1 and silently sorts it to the front, whereas a new PostureProductCategory
// that isn't ranked here fails the build.
const CATEGORY_ORDER: Record<PostureProductCategory, number> = {
  mdr: 0,
  edr: 1,
  antivirus: 2,
  dns_filtering: 3,
  backup: 4,
  identity: 5,
};

export function prettySecurityProvider(provider: string): string {
  return PROVIDER_NAMES[provider] ?? provider;
}

export function categoryForEndpointProvider(provider: string): 'edr' | 'antivirus' {
  return EDR_PROVIDERS.has(provider) ? 'edr' : 'antivirus';
}

const productKey = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');

export function buildSecurityProductInventory(
  evidence: SecurityProductEvidence[],
): PostureProduct[] {
  const merged = new Map<
    string,
    {
      product: string;
      category: PostureProductCategory;
      active: boolean;
      lastSyncStatus: string | null;
      deviceIds: Set<string> | null;
    }
  >();

  for (const item of evidence) {
    const key = productKey(item.product);
    const current = merged.get(key);
    const ids = item.deviceIds ? new Set(item.deviceIds) : null;
    if (!current) {
      merged.set(key, {
        product: item.product,
        category: item.category,
        active: item.active,
        lastSyncStatus: item.lastSyncStatus ?? null,
        deviceIds: ids,
      });
      continue;
    }
    current.active ||= item.active;
    current.lastSyncStatus ??= item.lastSyncStatus ?? null;
    if (ids) {
      current.deviceIds ??= new Set();
      for (const id of ids) current.deviceIds.add(id);
    }
  }

  return [...merged.values()]
    .map((item) => ({
      product: item.product,
      category: item.category,
      active: item.active,
      lastSyncStatus: item.lastSyncStatus,
      deviceCoverage: item.deviceIds?.size ?? null,
    }))
    .sort(
      (a, b) =>
        CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category] ||
        a.product.localeCompare(b.product),
    );
}
