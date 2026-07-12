import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./discovery', () => ({
  discoverExtensions: vi.fn(() => [
    {
      name: 'sample',
      dir: '/x/sample',
      migrationsDir: null,
      manifest: {
        name: 'sample', routeNamespace: 'sample', entry: 'src/index.ts',
        migrationsDir: 'migrations',
        tenancy: {
          orgCascadeDeleteTables: ['sample_items', 'memory_blocks'],
          deviceCascadeDeleteTables: ['sample_child', 'sample_parent'],
          deviceOrgDenormalizedTables: ['sample_events'],
          deviceOrgMoveDeleteTables: ['demo_things'],
        },
      },
    },
  ]),
}));

import { discoverExtensions } from './discovery';
import {
  withExtensionOrgCascade,
  withExtensionDeviceCascade,
  withExtensionDeviceOrgDenormalized,
  withExtensionDeviceOrgMoveDelete,
  resetExtensionTenancyCacheForTests,
} from './tenancyRegistry';

beforeEach(() => {
  vi.clearAllMocks();
  resetExtensionTenancyCacheForTests();
});

describe('tenancyRegistry', () => {
  it('unions org-cascade tables alphabetised with organizations last', () => {
    const merged = withExtensionOrgCascade(['alerts', 'devices', 'organizations']);
    expect(merged).toEqual(['alerts', 'devices', 'memory_blocks', 'sample_items', 'organizations']);
  });

  it('does not add organizations when neither core nor extensions declare it', () => {
    expect(withExtensionOrgCascade(['devices', 'alerts'])).toEqual([
      'alerts', 'devices', 'memory_blocks', 'sample_items',
    ]);
  });

  it('includes extension-declared organizations exactly once and last', () => {
    vi.mocked(discoverExtensions).mockReturnValueOnce([
      {
        name: 'sample',
        dir: '/x/sample',
        migrationsDir: null,
        manifest: {
          name: 'sample', routeNamespace: 'sample', entry: 'src/index.ts',
          migrationsDir: 'migrations',
          tenancy: {
            orgCascadeDeleteTables: ['organizations', 'sample_items', 'organizations'],
            deviceCascadeDeleteTables: ['sample_child', 'sample_parent'],
            deviceOrgDenormalizedTables: ['sample_events'],
            deviceOrgMoveDeleteTables: ['demo_things'],
          },
        },
      },
    ]);

    expect(withExtensionOrgCascade(['devices'])).toEqual([
      'devices', 'sample_items', 'organizations',
    ]);
  });

  it('prepends extension device-cascade tables, preserving core order', () => {
    expect(withExtensionDeviceCascade(['backup_chains', 'backup_jobs'])).toEqual([
      'sample_child', 'sample_parent', 'backup_chains', 'backup_jobs',
    ]);
  });

  it('appends device-org-denormalized tables', () => {
    expect(withExtensionDeviceOrgDenormalized(['agent_logs'])).toEqual([
      'agent_logs', 'sample_events',
    ]);
  });

  it('prepends extension device-org-move-delete tables, preserving core order', () => {
    expect(withExtensionDeviceOrgMoveDelete([])).toEqual(['demo_things']);
  });

  it('is a pure pass-through with no extensions', async () => {
    vi.mocked(discoverExtensions).mockReturnValueOnce([]);
    resetExtensionTenancyCacheForTests();
    expect(withExtensionOrgCascade(['alerts', 'organizations'])).toEqual(['alerts', 'organizations']);
  });

  it('caches discovery across getters and discovers again after reset', () => {
    withExtensionOrgCascade(['alerts', 'organizations']);
    withExtensionDeviceCascade(['backup_jobs']);
    expect(discoverExtensions).toHaveBeenCalledTimes(1);

    resetExtensionTenancyCacheForTests();
    withExtensionDeviceOrgDenormalized(['agent_logs']);
    expect(discoverExtensions).toHaveBeenCalledTimes(2);
  });
});
