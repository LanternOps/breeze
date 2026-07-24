import type { PostureProduct, PostureProductCategory } from '@breeze/shared';

// `deviceCoverage` and `activeDeviceCoverage` are computed by the inventory
// builder from `deviceIds` + `active`, so they are not part of the per-source
// evidence input.
export type SecurityProductEvidence = Omit<
  PostureProduct,
  'deviceCoverage' | 'activeDeviceCoverage'
> & {
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
      // All devices the product is inventoried across (installed count).
      deviceIds: Set<string> | null;
      // Subset of `deviceIds` where THIS device's evidence was active — for native
      // AV rows that is "real-time protection on". Tracked separately from the
      // OR-merged `active` flag so one RTP-on device can't paint the whole product
      // as fully protecting the fleet (issue #2517). Integration evidence keeps the
      // OR-merge on `active`; its per-device set is either full (all devices active)
      // or absent (no deviceIds), so it never produces a misleading partial count.
      activeDeviceIds: Set<string> | null;
    }
  >();

  for (const item of evidence) {
    const key = productKey(item.product);
    const ids = item.deviceIds ? new Set(item.deviceIds) : null;
    const activeIds = ids && item.active ? new Set(ids) : null;
    const current = merged.get(key);
    if (!current) {
      merged.set(key, {
        product: item.product,
        category: item.category,
        active: item.active,
        lastSyncStatus: item.lastSyncStatus ?? null,
        deviceIds: ids,
        activeDeviceIds: activeIds,
      });
      continue;
    }
    current.active ||= item.active;
    current.lastSyncStatus ??= item.lastSyncStatus ?? null;
    if (ids) {
      current.deviceIds ??= new Set();
      for (const id of ids) current.deviceIds.add(id);
    }
    if (activeIds) {
      current.activeDeviceIds ??= new Set();
      for (const id of activeIds) current.activeDeviceIds.add(id);
    }
  }

  return [...merged.values()]
    .map((item) => ({
      product: item.product,
      category: item.category,
      active: item.active,
      lastSyncStatus: item.lastSyncStatus,
      deviceCoverage: item.deviceIds?.size ?? null,
      // Only meaningful when we have per-device evidence; null otherwise so the
      // renderer skips the "N with real-time protection on" suffix for pure
      // integration health rows (DNS, backup, M365).
      activeDeviceCoverage: item.deviceIds ? (item.activeDeviceIds?.size ?? 0) : null,
    }))
    .sort(
      (a, b) =>
        CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category] ||
        a.product.localeCompare(b.product),
    );
}
