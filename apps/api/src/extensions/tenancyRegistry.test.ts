import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./discovery', () => ({
  discoverExtensions: vi.fn(() => [
    {
      name: 'sample',
      dir: '/x/sample',
      migrationsDir: null,
      manifest: {
        name: 'sample', routeNamespace: 'sample', entry: 'src/index.ts',
        migrationsDir: 'migrations', helperRoutes: false,
        tenancy: {
          orgCascadeDeleteTables: ['sample_items', 'memory_blocks'],
          orgExportColumns: {
            sample_items: {
              include: ['id', 'org_id', 'display_name', 'access_token_status'],
              exclude: ['credential_hash', 'metadata'],
            },
            memory_blocks: {
              include: ['id', 'org_id', 'content_type'],
              exclude: ['data'],
            },
          },
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
  CORE_TENANT_EXPORT_POLICY,
  getTenantExportPolicyRegistry,
} from '../services/tenantExportPolicyRegistry';
import {
  withExtensionOrgCascade,
  withExtensionDeviceCascade,
  withExtensionDeviceOrgDenormalized,
  withExtensionDeviceOrgMoveDelete,
  getExtensionOrgExportColumns,
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
          migrationsDir: 'migrations', helperRoutes: false,
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

  it('dedupes a core/extension overlap WITHOUT hoisting the core table out of its FK-ordered position', () => {
    // `sample_parent` is declared by both the extension and core, and sits LAST
    // in core's FK order. A naive Set-dedupe keeps the first occurrence and
    // would hoist it to the front (['sample_child','sample_parent','backup_jobs']),
    // letting it be deleted before rows that FK-reference it → 23503. Core's
    // ordering must win.
    expect(withExtensionDeviceCascade(['backup_jobs', 'sample_parent'])).toEqual([
      'sample_child', 'backup_jobs', 'sample_parent',
    ]);
  });

  it('dedupes a shared table declared by two extensions in device-cascade lists', () => {
    const sampleManifest = {
      name: 'sample', routeNamespace: 'sample', entry: 'src/index.ts',
      migrationsDir: 'migrations', helperRoutes: false,
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

  it('returns complete extension org-export classifications', () => {
    expect(getExtensionOrgExportColumns()).toEqual({
      sample_items: {
        include: ['id', 'org_id', 'display_name', 'access_token_status'],
        exclude: ['credential_hash', 'metadata'],
      },
      memory_blocks: {
        include: ['id', 'org_id', 'content_type'],
        exclude: ['data'],
      },
    });
  });

  it('fails when an org-cascade extension table has no export policy', () => {
    vi.mocked(discoverExtensions).mockReturnValueOnce([
      {
        name: 'sample',
        dir: '/x/sample',
        migrationsDir: null,
        manifest: {
          name: 'sample', routeNamespace: 'sample', entry: 'src/index.ts',
          migrationsDir: 'migrations', helperRoutes: false,
          tenancy: {
            orgCascadeDeleteTables: ['sample_items'],
            orgExportColumns: {},
            deviceCascadeDeleteTables: [],
            deviceOrgDenormalizedTables: [],
          },
        },
      },
    ]);

    expect(() => getExtensionOrgExportColumns()).toThrow(/sample_items.*classification/i);
  });

  it.each([
    ['duplicate include', { include: ['id', 'id', 'org_id'], exclude: [] }],
    ['duplicate exclude', { include: ['id', 'org_id'], exclude: ['secret', 'secret'] }],
    ['include/exclude overlap', { include: ['id', 'org_id'], exclude: ['id'] }],
  ])('rejects %s in an extension export policy', (_label, exportPolicy) => {
    vi.mocked(discoverExtensions).mockReturnValueOnce([
      {
        name: 'sample',
        dir: '/x/sample',
        migrationsDir: null,
        manifest: {
          name: 'sample', routeNamespace: 'sample', entry: 'src/index.ts',
          migrationsDir: 'migrations', helperRoutes: false,
          tenancy: {
            orgCascadeDeleteTables: ['sample_items'],
            orgExportColumns: { sample_items: exportPolicy },
            deviceCascadeDeleteTables: [],
            deviceOrgDenormalizedTables: [],
          },
        },
      },
    ]);

    expect(() => getExtensionOrgExportColumns()).toThrow(/sample_items.*duplicate|sample_items.*overlap/i);
  });

  it('rejects two extensions that classify the same table inconsistently', () => {
    const first = {
      name: 'sample', routeNamespace: 'sample', entry: 'src/index.ts',
      migrationsDir: 'migrations', helperRoutes: false,
      tenancy: {
        orgCascadeDeleteTables: ['memory_blocks'],
        orgExportColumns: {
          memory_blocks: { include: ['id', 'org_id'], exclude: ['data'] },
        },
        deviceCascadeDeleteTables: [],
        deviceOrgDenormalizedTables: [],
      },
    };
    vi.mocked(discoverExtensions).mockReturnValueOnce([
      { name: 'sample', dir: '/x/sample', migrationsDir: null, manifest: first },
      {
        name: 'other',
        dir: '/x/other',
        migrationsDir: null,
        manifest: {
          ...first,
          name: 'other',
          routeNamespace: 'other',
          tenancy: {
            ...first.tenancy,
            orgExportColumns: {
              memory_blocks: { include: ['id', 'org_id', 'data'], exclude: [] },
            },
          },
        },
      },
    ]);

    expect(() => getExtensionOrgExportColumns()).toThrow(/memory_blocks.*inconsistent/i);
  });

  it('dedupes identical classifications for a shared extension table', () => {
    const sharedPolicy = { include: ['id', 'org_id'], exclude: ['data'] };
    const manifest = {
      name: 'sample', routeNamespace: 'sample', entry: 'src/index.ts',
      migrationsDir: 'migrations', helperRoutes: false,
      tenancy: {
        orgCascadeDeleteTables: ['memory_blocks'],
        orgExportColumns: { memory_blocks: sharedPolicy },
        deviceCascadeDeleteTables: [],
        deviceOrgDenormalizedTables: [],
      },
    };
    vi.mocked(discoverExtensions).mockReturnValueOnce([
      { name: 'sample', dir: '/x/sample', migrationsDir: null, manifest },
      {
        name: 'other',
        dir: '/x/other',
        migrationsDir: null,
        manifest: { ...manifest, name: 'other', routeNamespace: 'other' },
      },
    ]);

    expect(getExtensionOrgExportColumns()).toEqual({
      memory_blocks: sharedPolicy,
    });
  });

  it('adapts explicit suspicious and open-container extension decisions as reviewed', () => {
    const policy = getTenantExportPolicyRegistry().sample_items;

    expect(policy).toMatchObject({ organizationKey: 'org_id' });
    expect(policy?.columns.access_token_status).toMatchObject({
      decision: 'include',
      reviewedSensitiveName: true,
      openContainerReviewed: true,
    });
    expect(policy?.columns.credential_hash).toMatchObject({
      decision: 'exclude',
      reviewedSensitiveName: true,
      openContainerReviewed: true,
    });
    expect(policy?.columns.metadata).toMatchObject({
      decision: 'exclude',
      openContainerReviewed: true,
    });
  });

  it.each([
    ['contract_documents', 'pdf_data'],
    ['contract_template_versions', 'file_data'],
    ['invoice_documents', 'pdf'],
    ['quote_images', 'image_data'],
    ['users', 'avatar_data'],
  ])('explicitly reviews and excludes core bytea column %s.%s', (table, column) => {
    expect(CORE_TENANT_EXPORT_POLICY[table]?.columns[column]).toMatchObject({
      decision: 'exclude',
      openContainerReviewed: true,
    });
  });

  it.each([
    ['c2c_consent_sessions', 'state'],
    ['device_config_state', 'config_value'],
    ['device_registry_state', 'value_data'],
    ['enrollment_keys', 'short_code'],
    ['google_workspace_connections', 'service_account_key'],
    ['m365_consent_sessions', 'nonce'],
    ['m365_consent_sessions', 'code_verifier'],
  ])('excludes reviewed core capability or opaque-value alias %s.%s', (table, column) => {
    expect(CORE_TENANT_EXPORT_POLICY[table]?.columns[column]).toMatchObject({
      decision: 'exclude',
      reviewedSensitiveName: true,
      openContainerReviewed: true,
    });
  });
});
