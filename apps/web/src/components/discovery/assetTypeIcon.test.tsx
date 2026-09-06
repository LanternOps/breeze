import { describe, expect, it } from 'vitest';
import { assetTypeIcon, assetTypeIcons } from './assetTypeIcon';
import { typeConfig, type DiscoveredAssetType } from './DiscoveredAssetList';

describe('assetTypeIcons', () => {
  it('has an icon for every DiscoveredAssetType', () => {
    const types = Object.keys(typeConfig) as DiscoveredAssetType[];
    expect(types.length).toBeGreaterThan(0);
    for (const type of types) {
      expect(assetTypeIcons[type]).toBeDefined();
      expect(assetTypeIcon(type)).toBe(assetTypeIcons[type]);
    }
  });

  it('falls back to the unknown icon for an out-of-enum value', () => {
    expect(assetTypeIcon('bogus' as DiscoveredAssetType)).toBe(assetTypeIcons.unknown);
  });
});
