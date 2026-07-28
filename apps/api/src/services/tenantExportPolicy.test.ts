import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  columns: [] as Array<{
    tableName: string;
    columnName: string;
    dataType: string;
    udtName: string;
    ordinalPosition: number;
  }>,
}));

vi.mock('../db', () => ({
  db: {
    execute: vi.fn(async () => mockState.columns),
  },
}));

import { db } from '../db';
import { findTenantExportPolicyIssues } from '../../scripts/check-tenant-export-policy';
import {
  buildTenantExportPlan,
  type TenantExportPolicyRegistry,
} from './tenantExportPolicy';
import {
  CORE_TENANT_EXPORT_POLICY,
  tablePolicy,
} from './tenantExportPolicyRegistry';

function column(
  tableName: string,
  columnName: string,
  dataType = 'text',
  ordinalPosition = 1,
  udtName = dataType,
) {
  return { tableName, columnName, dataType, udtName, ordinalPosition };
}

function policy(
  organizationKey: 'id' | 'org_id',
  columns: TenantExportPolicyRegistry[string]['columns'],
): TenantExportPolicyRegistry[string] {
  return { organizationKey, columns };
}

describe('buildTenantExportPlan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.columns = [];
  });

  it('fails closed when an existing table has no policy', async () => {
    mockState.columns = [column('widgets', 'org_id')];

    await expect(buildTenantExportPlan(['widgets'], {})).rejects.toThrow(
      /widgets.*policy/i,
    );
  });

  it('reports live columns missing from policy and stale policy columns', async () => {
    mockState.columns = [
      column('widgets', 'id', 'uuid', 1),
      column('widgets', 'org_id', 'uuid', 2),
      column('widgets', 'name', 'text', 3),
    ];
    const registry: TenantExportPolicyRegistry = {
      widgets: policy('org_id', {
        id: { decision: 'include', rationale: 'Stable row identifier.' },
        org_id: { decision: 'include', rationale: 'Tenant ownership identifier.' },
        removed_column: { decision: 'exclude', rationale: 'No longer present.' },
      }),
    };

    await expect(buildTenantExportPlan(['widgets'], registry)).rejects.toThrow(
      /name.*removed_column|removed_column.*name/i,
    );
  });

  it('rejects duplicate requested tables and duplicate live column rows', async () => {
    await expect(buildTenantExportPlan(['widgets', 'widgets'], {})).rejects.toThrow(
      /duplicate.*widgets/i,
    );

    mockState.columns = [
      column('widgets', 'org_id', 'uuid', 1),
      column('widgets', 'org_id', 'uuid', 1),
    ];
    const registry: TenantExportPolicyRegistry = {
      widgets: policy('org_id', {
        org_id: { decision: 'include', rationale: 'Tenant ownership identifier.' },
      }),
    };

    await expect(buildTenantExportPlan(['widgets'], registry)).rejects.toThrow(
      /duplicate.*org_id/i,
    );
  });

  it('requires explicit review before including a suspiciously named column', async () => {
    mockState.columns = [
      column('widgets', 'org_id', 'uuid', 1),
      column('widgets', 'access_token_hash', 'text', 2),
    ];
    const registry: TenantExportPolicyRegistry = {
      widgets: policy('org_id', {
        org_id: { decision: 'include', rationale: 'Tenant ownership identifier.' },
        access_token_hash: {
          decision: 'include',
          rationale: 'Needed for a reviewed portability workflow.',
        },
      }),
    };

    await expect(buildTenantExportPlan(['widgets'], registry)).rejects.toThrow(
      /access_token_hash.*reviewedSensitiveName/i,
    );
  });

  it.each([
    ['jsonb type', column('widgets', 'preferences', 'jsonb', 2, 'jsonb')],
    ['bytea type', column('widgets', 'document', 'bytea', 2, 'bytea')],
    ['open-container name', column('widgets', 'metadata', 'text', 2, 'text')],
  ])('requires explicit open-container review for a %s', async (_label, openColumn) => {
    mockState.columns = [
      column('widgets', 'org_id', 'uuid', 1),
      openColumn,
    ];
    const registry: TenantExportPolicyRegistry = {
      widgets: policy('org_id', {
        org_id: { decision: 'include', rationale: 'Tenant ownership identifier.' },
        [openColumn.columnName]: {
          decision: 'exclude',
          rationale: 'Container content is not part of the portable contract.',
        },
      }),
    };

    await expect(buildTenantExportPlan(['widgets'], registry)).rejects.toThrow(
      new RegExp(`${openColumn.columnName}.*openContainerReviewed`, 'i'),
    );
  });

  it('rejects an organization key that does not match the table shape', async () => {
    mockState.columns = [
      column('widgets', 'id', 'uuid', 1),
      column('widgets', 'org_id', 'uuid', 2),
      column('organizations', 'id', 'uuid', 1),
    ];
    const registry: TenantExportPolicyRegistry = {
      widgets: policy('id', {
        id: { decision: 'include', rationale: 'Stable row identifier.' },
        org_id: { decision: 'include', rationale: 'Tenant ownership identifier.' },
      }),
      organizations: policy('org_id', {
        id: { decision: 'include', rationale: 'Organization identifier.' },
      }),
    };

    await expect(
      buildTenantExportPlan(['widgets', 'organizations'], registry),
    ).rejects.toThrow(/organization key/i);
  });

  it('infers an id-keyed table structurally without hardcoding a table name', async () => {
    mockState.columns = [
      column('tenant_accounts', 'id', 'uuid', 1),
      column('tenant_accounts', 'name', 'text', 2),
    ];
    const registry: TenantExportPolicyRegistry = {
      tenant_accounts: policy('id', {
        id: { decision: 'include', rationale: 'Tenant account identifier.' },
        name: { decision: 'include', rationale: 'Customer-owned account name.' },
      }),
    };

    await expect(
      buildTenantExportPlan(['tenant_accounts'], registry),
    ).resolves.toEqual([
      {
        table: 'tenant_accounts',
        organizationKey: 'id',
        includedColumns: ['id', 'name'],
      },
    ]);
  });

  it('rejects unsafe table and live-column identifiers', async () => {
    await expect(buildTenantExportPlan(['widgets;drop'], {})).rejects.toThrow(
      /unsafe identifier/i,
    );

    mockState.columns = [column('widgets', 'bad-column')];
    const registry: TenantExportPolicyRegistry = {
      widgets: policy('org_id', {
        'bad-column': { decision: 'exclude', rationale: 'Unsafe identifier fixture.' },
      }),
    };
    await expect(buildTenantExportPlan(['widgets'], registry)).rejects.toThrow(
      /unsafe identifier/i,
    );
  });

  it('returns only explicitly included columns in live ordinal order', async () => {
    mockState.columns = [
      column('widgets', 'id', 'uuid', 1),
      column('widgets', 'org_id', 'uuid', 2),
      column('widgets', 'name', 'text', 3),
      column('widgets', 'credentials', 'jsonb', 4, 'jsonb'),
      column('organizations', 'id', 'uuid', 1),
      column('organizations', 'name', 'text', 2),
    ];
    const registry: TenantExportPolicyRegistry = {
      widgets: policy('org_id', {
        id: { decision: 'include', rationale: 'Stable row identifier.' },
        org_id: { decision: 'include', rationale: 'Tenant ownership identifier.' },
        name: { decision: 'include', rationale: 'Customer-owned display name.' },
        credentials: {
          decision: 'exclude',
          rationale: 'Credential containers are prohibited from tenant exports.',
          reviewedSensitiveName: true,
          openContainerReviewed: true,
        },
      }),
      organizations: policy('id', {
        id: { decision: 'include', rationale: 'Organization identifier.' },
        name: { decision: 'include', rationale: 'Customer-owned organization name.' },
      }),
    };

    await expect(
      buildTenantExportPlan(['widgets', 'organizations'], registry),
    ).resolves.toEqual([
      {
        table: 'widgets',
        organizationKey: 'org_id',
        includedColumns: ['id', 'org_id', 'name'],
      },
      {
        table: 'organizations',
        organizationKey: 'id',
        includedColumns: ['id', 'name'],
      },
    ]);
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it('omits cascade tables that do not exist in this deployment', async () => {
    mockState.columns = [column('organizations', 'id', 'uuid', 1)];
    const registry: TenantExportPolicyRegistry = {
      optional_widgets: policy('org_id', {
        org_id: { decision: 'include', rationale: 'Tenant ownership identifier.' },
      }),
      organizations: policy('id', {
        id: { decision: 'include', rationale: 'Organization identifier.' },
      }),
    };

    await expect(
      buildTenantExportPlan(['optional_widgets', 'organizations'], registry),
    ).resolves.toEqual([
      {
        table: 'organizations',
        organizationKey: 'id',
        includedColumns: ['id'],
      },
    ]);
  });
});

describe('CORE_TENANT_EXPORT_POLICY migration-era columns', () => {
  it('rejects a column classified in both a shared group and a specific decision', () => {
    expect(() =>
      tablePolicy('org_id', {
        included: ['search_vector'],
        reviewedIncluded: [],
        excludedSensitive: [],
        excludedOpen: [],
        specific: {
          search_vector: {
            decision: 'exclude',
            rationale: 'Derived search data is excluded.',
          },
        },
      }),
    ).toThrow(/duplicate classification.*search_vector/i);
  });

  it('classifies derived search vectors and versioned discriminator columns explicitly', () => {
    const tables = ['device_event_logs', 'restore_jobs'] as const;
    const liveColumns = tables.flatMap((tableName) => [
      ...Object.keys(CORE_TENANT_EXPORT_POLICY[tableName]!.columns).map(
        (columnName) => ({ tableName, columnName }),
      ),
      {
        tableName,
        columnName:
          tableName === 'device_event_logs'
            ? 'search_vector'
            : 'restore_type_v2',
      },
    ]);

    expect(
      findTenantExportPolicyIssues(
        tables,
        liveColumns,
        CORE_TENANT_EXPORT_POLICY,
      ),
    ).toEqual([]);
    expect(
      CORE_TENANT_EXPORT_POLICY.device_event_logs!.columns.search_vector,
    ).toMatchObject({ decision: 'exclude' });
    expect(
      CORE_TENANT_EXPORT_POLICY.restore_jobs!.columns.restore_type_v2,
    ).toMatchObject({ decision: 'include' });
  });

  it('fails closed for a future neutral derived column', () => {
    const tableName = 'device_event_logs';
    const liveColumns = [
      ...Object.keys(CORE_TENANT_EXPORT_POLICY[tableName]!.columns).map(
        (columnName) => ({ tableName, columnName }),
      ),
      { tableName, columnName: 'future_derived_projection' },
    ];

    expect(
      findTenantExportPolicyIssues(
        [tableName],
        liveColumns,
        CORE_TENANT_EXPORT_POLICY,
      ),
    ).toEqual([
      'device_event_logs.future_derived_projection: unclassified',
    ]);
  });
});
