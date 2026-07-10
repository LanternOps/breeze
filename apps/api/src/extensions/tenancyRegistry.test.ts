import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./discovery', () => ({
  discoverExtensions: vi.fn(() => [
    {
      name: 'workspace',
      dir: '/x/workspace',
      migrationsDir: null,
      manifest: {
        name: 'workspace', routeNamespace: 'workspace', entry: 'src/index.ts',
        migrationsDir: 'migrations',
        tenancy: {
          orgCascadeDeleteTables: ['workspace_sources', 'memory_blocks'],
          deviceCascadeDeleteTables: ['workspace_child', 'workspace_parent'],
          deviceOrgDenormalizedTables: ['workspace_file_activity'],
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
  resetExtensionTenancyCacheForTests,
} from './tenancyRegistry';

beforeEach(() => {
  vi.clearAllMocks();
  resetExtensionTenancyCacheForTests();
});

describe('tenancyRegistry', () => {
  it('unions org-cascade tables alphabetised with organizations last', () => {
    const merged = withExtensionOrgCascade(['alerts', 'devices', 'organizations']);
    expect(merged).toEqual(['alerts', 'devices', 'memory_blocks', 'workspace_sources', 'organizations']);
  });

  it('does not add organizations when neither core nor extensions declare it', () => {
    expect(withExtensionOrgCascade(['devices', 'alerts'])).toEqual([
      'alerts', 'devices', 'memory_blocks', 'workspace_sources',
    ]);
  });

  it('includes extension-declared organizations exactly once and last', () => {
    vi.mocked(discoverExtensions).mockReturnValueOnce([
      {
        name: 'workspace',
        dir: '/x/workspace',
        migrationsDir: null,
        manifest: {
          name: 'workspace', routeNamespace: 'workspace', entry: 'src/index.ts',
          migrationsDir: 'migrations',
          tenancy: {
            orgCascadeDeleteTables: ['organizations', 'workspace_sources', 'organizations'],
            deviceCascadeDeleteTables: ['workspace_child', 'workspace_parent'],
            deviceOrgDenormalizedTables: ['workspace_file_activity'],
          },
        },
      },
    ]);

    expect(withExtensionOrgCascade(['devices'])).toEqual([
      'devices', 'workspace_sources', 'organizations',
    ]);
  });

  it('prepends extension device-cascade tables, preserving core order', () => {
    expect(withExtensionDeviceCascade(['backup_chains', 'backup_jobs'])).toEqual([
      'workspace_child', 'workspace_parent', 'backup_chains', 'backup_jobs',
    ]);
  });

  it('appends device-org-denormalized tables', () => {
    expect(withExtensionDeviceOrgDenormalized(['agent_logs'])).toEqual([
      'agent_logs', 'workspace_file_activity',
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
