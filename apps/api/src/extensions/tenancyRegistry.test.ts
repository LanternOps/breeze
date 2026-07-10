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
          deviceCascadeDeleteTables: [],
          deviceOrgDenormalizedTables: ['workspace_file_activity'],
        },
      },
    },
  ]),
}));

import {
  withExtensionOrgCascade,
  withExtensionDeviceCascade,
  withExtensionDeviceOrgDenormalized,
  resetExtensionTenancyCacheForTests,
} from './tenancyRegistry';

beforeEach(() => resetExtensionTenancyCacheForTests());

describe('tenancyRegistry', () => {
  it('unions org-cascade tables alphabetised with organizations last', () => {
    const merged = withExtensionOrgCascade(['alerts', 'devices', 'organizations']);
    expect(merged).toEqual(['alerts', 'devices', 'memory_blocks', 'workspace_sources', 'organizations']);
  });

  it('prepends extension device-cascade tables, preserving core order', () => {
    expect(withExtensionDeviceCascade(['backup_chains', 'backup_jobs'])).toEqual([
      'backup_chains', 'backup_jobs', // no extension device-cascade tables declared
    ]);
  });

  it('appends device-org-denormalized tables', () => {
    expect(withExtensionDeviceOrgDenormalized(['agent_logs'])).toEqual([
      'agent_logs', 'workspace_file_activity',
    ]);
  });

  it('is a pure pass-through with no extensions', async () => {
    const { discoverExtensions } = await import('./discovery');
    vi.mocked(discoverExtensions).mockReturnValueOnce([]);
    resetExtensionTenancyCacheForTests();
    expect(withExtensionOrgCascade(['alerts', 'organizations'])).toEqual(['alerts', 'organizations']);
  });
});
