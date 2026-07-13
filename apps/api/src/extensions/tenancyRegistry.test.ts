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

  it('dedupes device-cascade tables declared by both an extension and core, keeping the first (extension) position', () => {
    expect(withExtensionDeviceCascade(['sample_parent', 'backup_jobs'])).toEqual([
      'sample_child', 'sample_parent', 'backup_jobs',
    ]);
  });

  it('dedupes a shared table declared by two extensions in device-cascade lists', () => {
    const sampleManifest = {
      name: 'sample', routeNamespace: 'sample', entry: 'src/index.ts',
      migrationsDir: 'migrations',
      tenancy: {
        orgCascadeDeleteTables: [],
        deviceCascadeDeleteTables: ['memory_blocks', 'sample_child'],
        deviceOrgDenormalizedTables: [],
      },
    };
    vi.mocked(discoverExtensions).mockReturnValueOnce([
      { name: 'sample', dir: '/x/sample', migrationsDir: null, manifest: sampleManifest },
      {
        name: 'other', dir: '/x/other', migrationsDir: null,
        manifest: {
          ...sampleManifest, name: 'other', routeNamespace: 'other',
          tenancy: { ...sampleManifest.tenancy, deviceCascadeDeleteTables: ['memory_blocks', 'other_child'] },
        },
      },
    ]);
    expect(withExtensionDeviceCascade(['devices_data'])).toEqual([
      'memory_blocks', 'sample_child', 'other_child', 'devices_data',
    ]);
  });

  it('dedupes device-org-move-delete and device-org-denormalized overlaps with core', () => {
    expect(withExtensionDeviceOrgMoveDelete(['demo_things', 'core_rows'])).toEqual([
      'demo_things', 'core_rows',
    ]);
    expect(withExtensionDeviceOrgDenormalized(['sample_events', 'agent_logs'])).toEqual([
      'sample_events', 'agent_logs',
    ]);
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
