// apps/web/src/components/devices/networkDevice/settings/assetTypeGroups.ts
// The grouped device-type table for the Identity section's select.
//
// The grouping is presentational, but the MEMBERSHIP is a contract: these are
// exactly the twelve values `updateAssetSchema.assetType` accepts in
// apps/api/src/routes/discovery.ts. `website` and `service` exist in the DB
// enum and in typeConfig (#5213 W03, manual URL-identity assets) but the PATCH
// route rejects them, so offering them here would 400 with no explanation.
// assetTypeGroups.test.ts pins the list against the route's enum.

import type { DiscoveredAssetType } from '@/components/discovery/DiscoveredAssetList';

export const ASSET_TYPE_GROUPS = [
  {
    labelKey: 'networkDeviceDetailPage.settings.identity.typeGroups.endpoints',
    types: ['workstation', 'server'],
  },
  {
    labelKey: 'networkDeviceDetailPage.settings.identity.typeGroups.networkGear',
    types: ['router', 'switch', 'firewall', 'access_point'],
  },
  {
    labelKey: 'networkDeviceDetailPage.settings.identity.typeGroups.peripherals',
    types: ['printer', 'camera', 'phone', 'nas'],
  },
  {
    labelKey: 'networkDeviceDetailPage.settings.identity.typeGroups.other',
    types: ['iot', 'unknown'],
  },
] as const satisfies ReadonlyArray<{ labelKey: string; types: readonly DiscoveredAssetType[] }>;

export const PATCHABLE_ASSET_TYPES: readonly DiscoveredAssetType[] =
  ASSET_TYPE_GROUPS.flatMap((group): readonly DiscoveredAssetType[] => group.types);

export function isPatchableAssetType(type: DiscoveredAssetType): boolean {
  return (PATCHABLE_ASSET_TYPES as readonly string[]).includes(type);
}
