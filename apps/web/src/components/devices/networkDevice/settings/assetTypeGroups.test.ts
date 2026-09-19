// apps/web/src/components/devices/networkDevice/settings/assetTypeGroups.test.ts
import { describe, expect, it } from 'vitest';

import { ASSET_TYPE_GROUPS, PATCHABLE_ASSET_TYPES, isPatchableAssetType } from './assetTypeGroups';

// Mirrors routes/discovery.ts updateAssetSchema.assetType exactly. If the API
// widens or narrows that enum, this list is the thing that must move with it —
// a select offering a type the PATCH rejects is a 400 with no explanation.
const API_ACCEPTED = [
  'workstation', 'server', 'printer', 'router', 'switch', 'firewall',
  'access_point', 'phone', 'iot', 'camera', 'nas', 'unknown',
] as const;

describe('assetTypeGroups', () => {
  it('covers exactly the types PATCH /discovery/assets/:id accepts', () => {
    expect([...PATCHABLE_ASSET_TYPES].sort()).toEqual([...API_ACCEPTED].sort());
  });

  it('lists each type in exactly one group', () => {
    const flat = ASSET_TYPE_GROUPS.flatMap((g) => g.types);
    expect(new Set(flat).size).toBe(flat.length);
  });

  it('excludes website/service, which the PATCH route rejects', () => {
    expect(isPatchableAssetType('website')).toBe(false);
    expect(isPatchableAssetType('service')).toBe(false);
    expect(isPatchableAssetType('switch')).toBe(true);
  });
});
