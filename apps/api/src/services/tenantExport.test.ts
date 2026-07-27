import { beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import type { TenantExportPolicyRegistry } from './tenantExportPolicy';

const CASCADE_TABLES = ['alerts', 'devices', 'plugins', 'organizations'] as const;

const mockState = vi.hoisted(() => ({
  /** Raw per-table source rows. The execute mock applies the SQL projection. */
  rowsByTable: new Map<string, Record<string, unknown>[]>(),
  columns: [] as Array<{
    tableName: string;
    columnName: string;
    dataType: string;
    udtName: string;
    ordinalPosition: number;
  }>,
  queryLog: [] as string[],
  archiveAppends: [] as string[],
  outsideDbContextDepth: 0,
  systemContextOpenedOutside: [] as boolean[],
  cascadeTables: ['alerts', 'devices', 'plugins', 'organizations'] as string[],
  defaultPolicy: undefined as TenantExportPolicyRegistry | undefined,
}));

function sqlToText(q: unknown): string {
  if (q && typeof q === 'object' && 'queryChunks' in q) {
    const chunks = (q as { queryChunks: unknown[] }).queryChunks;
    return chunks
      .map((chunk) => {
        if (chunk && typeof chunk === 'object') {
          if ('value' in chunk && Array.isArray((chunk as { value: unknown[] }).value)) {
            return ((chunk as { value: string[] }).value).join('');
          }
          if ('queryChunks' in chunk) return sqlToText(chunk);
        }
        return '';
      })
      .join(' ');
  }
  return String(q);
}

vi.mock('./tenantCascade', () => ({
  getOrgCascadeDeleteOrder: vi.fn(() => [...mockState.cascadeTables]),
}));

vi.mock('./tenantExportPolicyRegistry', () => ({
  getTenantExportPolicyRegistry: vi.fn(() => mockState.defaultPolicy),
}));

vi.mock('archiver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('archiver')>();
  const createArchive = (
    actual as unknown as { default?: typeof actual }
  ).default ?? actual;
  return {
    ...actual,
    default: (...args: Parameters<typeof createArchive>) => {
      const archive = createArchive(...args);
      const append = archive.append.bind(archive);
      archive.append = ((source: Parameters<typeof append>[0], data: Parameters<typeof append>[1]) => {
        if (data?.name) mockState.archiveAppends.push(data.name);
        return append(source, data);
      }) as typeof archive.append;
      return archive;
    },
  };
});

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn(<T,>(fn: () => T) => {
    mockState.outsideDbContextDepth += 1;
    try {
      return fn();
    } finally {
      mockState.outsideDbContextDepth -= 1;
    }
  }),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    mockState.systemContextOpenedOutside.push(mockState.outsideDbContextDepth > 0);
    return fn();
  }),
  db: {
    execute: vi.fn(async (q: unknown) => {
      const text = sqlToText(q);
      mockState.queryLog.push(text);
      if (/information_schema\.columns/i.test(text)) return mockState.columns;

      const tableMatch = text.match(/FROM\s+"?([a-z_][a-z0-9_]*)"?/i);
      const table = tableMatch?.[1] ?? '';
      const sourceRows = mockState.rowsByTable.get(table) ?? [];
      const projection = text.match(/SELECT\s+(.+?)\s+FROM/is)?.[1] ?? '*';
      if (projection.trim() === '*') return sourceRows;

      const selectedColumns = [...projection.matchAll(/"([a-z_][a-z0-9_]*)"/gi)]
        .map((match) => match[1]!);
      return sourceRows.map((row) => Object.fromEntries(
        selectedColumns
          .filter((columnName) => Object.hasOwn(row, columnName))
          .map((columnName) => [columnName, row[columnName]]),
      ));
    }),
    insert: vi.fn(() => ({ values: vi.fn(() => Promise.resolve(undefined)) })),
  },
}));

import { buildOrgExportZip } from './tenantExport';
import * as dbModule from '../db';
import { getOrgCascadeDeleteOrder } from './tenantCascade';

function column(
  tableName: string,
  columnName: string,
  dataType = 'text',
  ordinalPosition = 1,
  udtName = dataType,
) {
  return { tableName, columnName, dataType, udtName, ordinalPosition };
}

const FIXTURE_POLICY: TenantExportPolicyRegistry = {
  alerts: {
    organizationKey: 'org_id',
    columns: {
      id: { decision: 'include', rationale: 'Stable alert identifier.' },
      org_id: { decision: 'include', rationale: 'Tenant ownership identifier.' },
    },
  },
  devices: {
    organizationKey: 'org_id',
    columns: {
      id: { decision: 'include', rationale: 'Stable device identifier.' },
      org_id: { decision: 'include', rationale: 'Tenant ownership identifier.' },
      name: { decision: 'include', rationale: 'Customer-owned device name.' },
      api_token_hash: {
        decision: 'exclude',
        rationale: 'Authentication material is prohibited from tenant exports.',
      },
    },
  },
  plugins: {
    organizationKey: 'org_id',
    columns: {
      id: { decision: 'include', rationale: 'Stable plugin identifier.' },
      org_id: { decision: 'include', rationale: 'Tenant ownership identifier.' },
    },
  },
  organizations: {
    organizationKey: 'id',
    columns: {
      id: { decision: 'include', rationale: 'Organization identifier.' },
      name: { decision: 'include', rationale: 'Customer-owned organization name.' },
    },
  },
};

function resetColumns(): void {
  mockState.columns = [
    column('alerts', 'id', 'uuid', 1),
    column('alerts', 'org_id', 'uuid', 2),
    column('devices', 'id', 'uuid', 1),
    column('devices', 'org_id', 'uuid', 2),
    column('devices', 'name', 'text', 3),
    column('devices', 'api_token_hash', 'text', 4),
    // plugins is intentionally absent to represent an optional table.
    column('organizations', 'id', 'uuid', 1),
    column('organizations', 'name', 'text', 2),
  ];
}

describe('buildOrgExportZip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.rowsByTable = new Map();
    mockState.queryLog = [];
    mockState.archiveAppends = [];
    mockState.outsideDbContextDepth = 0;
    mockState.systemContextOpenedOutside = [];
    mockState.cascadeTables = [...CASCADE_TABLES];
    mockState.defaultPolicy = FIXTURE_POLICY;
    resetColumns();
  });

  it('uses the checked-in registry by default at the production call site', async () => {
    await expect(buildOrgExportZip(
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002',
    )).resolves.toMatchObject({
      manifest: {
        orgId: '00000000-0000-0000-0000-000000000001',
      },
    });
    expect(mockState.queryLog[0]).toMatch(/information_schema\.columns/i);
  });

  it('returns a deterministic ZIP for every existing cascade table plus manifest.json', async () => {
    const { zipBuffer, manifest } = await buildOrgExportZip(
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002',
      'admin@example.com',
      FIXTURE_POLICY,
    );

    expect(zipBuffer).toBeInstanceOf(Buffer);
    expect(zipBuffer.length).toBeGreaterThan(0);

    const zip = await JSZip.loadAsync(zipBuffer);
    expect(Object.keys(zip.files)).toEqual([
      'alerts.json',
      'devices.json',
      'organizations.json',
      'manifest.json',
    ]);
    expect(manifest.actor).toBe('00000000-0000-0000-0000-000000000002');
    expect(manifest.actorEmail).toBe('admin@example.com');
    expect(manifest.orgId).toBe('00000000-0000-0000-0000-000000000001');
    expect(manifest.files).toHaveLength(3);
  });

  it('completes classification before any tenant query or archive append', async () => {
    const { alerts: _alerts, ...missingAlertsPolicy } = FIXTURE_POLICY;

    await expect(buildOrgExportZip(
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002',
      undefined,
      missingAlertsPolicy,
    )).rejects.toThrow(/alerts.*policy/i);

    expect(mockState.queryLog).toHaveLength(1);
    expect(mockState.queryLog[0]).toMatch(/information_schema\.columns/i);
    expect(mockState.archiveAppends).toEqual([]);
  });

  it('exits any request DB context before each fresh system-context query', async () => {
    await buildOrgExportZip(
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002',
      undefined,
      FIXTURE_POLICY,
    );

    // Preflight + three existing-table reads + the best-effort audit write.
    expect(dbModule.withSystemDbAccessContext).toHaveBeenCalledTimes(5);
    expect(mockState.systemContextOpenedOutside).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  it('uses explicit projections and never serializes an excluded secret key or value', async () => {
    const sentinel = 'EXCLUDED-DEVICE-TOKEN-HASH-SENTINEL';
    mockState.rowsByTable.set('devices', [{
      id: 'd1',
      org_id: '00000000-0000-0000-0000-000000000001',
      name: 'host-1',
      api_token_hash: sentinel,
    }]);

    const { zipBuffer } = await buildOrgExportZip(
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002',
      undefined,
      FIXTURE_POLICY,
    );

    const deviceQuery = mockState.queryLog.find((query) => /FROM\s+"devices"/i.test(query));
    expect(deviceQuery).toMatch(/SELECT\s+"id",\s*"org_id",\s*"name"\s+FROM/i);
    expect(deviceQuery).not.toContain('api_token_hash');

    const zip = await JSZip.loadAsync(zipBuffer);
    const serializedZip = await Promise.all(
      Object.values(zip.files).map((entry) => entry.async('string')),
    ).then((entries) => entries.join('\n'));
    expect(serializedZip).not.toContain('api_token_hash');
    expect(serializedZip).not.toContain(sentinel);
  });

  it('aborts an unclassified extension table before its rows are queried or appended', async () => {
    mockState.cascadeTables = ['sample_items'];
    mockState.columns = [
      column('sample_items', 'id', 'uuid', 1),
      column('sample_items', 'org_id', 'uuid', 2),
    ];

    await expect(buildOrgExportZip(
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002',
      undefined,
      {},
    )).rejects.toThrow(/sample_items.*policy/i);

    expect(mockState.queryLog).toHaveLength(1);
    expect(mockState.queryLog[0]).toMatch(/information_schema\.columns/i);
    expect(mockState.archiveAppends).toEqual([]);
  });

  it('exports only extension includes and excludes every prohibited secret class', async () => {
    const prohibitedColumns = [
      'password_hash',
      'mfa_secret',
      'mfa_recovery_codes',
      'api_key',
      'session_token',
      'access_token',
      'encrypted_access_token',
      'refresh_token',
      'encrypted_refresh_token',
      'invite_token',
      'enrollment_token',
      'provisioning_handle',
      'installer_token',
      'bootstrap_token',
      'reset_token',
      'client_secret',
      'webhook_secret',
      'private_key',
      'signing_private_key',
      'backup_encryption_key',
      'credentials',
      'headers',
      'certificate_private_key',
      'certificate_recovery_proof',
    ] as const;
    mockState.cascadeTables = ['sample_secure_records'];
    mockState.columns = [
      column('sample_secure_records', 'id', 'uuid', 1),
      column('sample_secure_records', 'org_id', 'uuid', 2),
      column('sample_secure_records', 'display_name', 'text', 3),
      ...prohibitedColumns.map((columnName, index) => column(
        'sample_secure_records',
        columnName,
        columnName === 'credentials' || columnName === 'headers' || columnName === 'mfa_recovery_codes'
          ? 'jsonb'
          : 'text',
        index + 4,
        columnName === 'credentials' || columnName === 'headers' || columnName === 'mfa_recovery_codes'
          ? 'jsonb'
          : 'text',
      )),
    ];
    const sentinels = Object.fromEntries(
      prohibitedColumns.map((columnName) => [
        columnName,
        `PROHIBITED-${columnName.toUpperCase()}-SENTINEL`,
      ]),
    );
    mockState.rowsByTable.set('sample_secure_records', [{
      id: 'record-1',
      org_id: '00000000-0000-0000-0000-000000000001',
      display_name: 'portable',
      ...sentinels,
    }]);
    const columns = Object.fromEntries([
      ['id', { decision: 'include' as const, rationale: 'Stable row identifier.' }],
      ['org_id', { decision: 'include' as const, rationale: 'Tenant ownership identifier.' }],
      ['display_name', { decision: 'include' as const, rationale: 'Customer-owned display name.' }],
      ...prohibitedColumns.map((columnName) => [
        columnName,
        {
          decision: 'exclude' as const,
          rationale: 'Prohibited authentication, credential, capability, or private-key material.',
          reviewedSensitiveName: true as const,
          openContainerReviewed: true as const,
        },
      ]),
    ]);
    const registry: TenantExportPolicyRegistry = {
      sample_secure_records: {
        organizationKey: 'org_id',
        columns,
      },
    };

    const { zipBuffer } = await buildOrgExportZip(
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002',
      undefined,
      registry,
    );

    const rowQuery = mockState.queryLog.find(
      (query) => /FROM\s+"sample_secure_records"/i.test(query),
    );
    expect(rowQuery).toMatch(/SELECT\s+"id",\s*"org_id",\s*"display_name"\s+FROM/i);
    const zip = await JSZip.loadAsync(zipBuffer);
    const serializedZip = await Promise.all(
      Object.values(zip.files).map((entry) => entry.async('string')),
    ).then((entries) => entries.join('\n'));
    for (const [columnName, sentinel] of Object.entries(sentinels)) {
      expect(serializedZip).not.toContain(columnName);
      expect(serializedZip).not.toContain(sentinel);
    }
    expect(serializedZip).toContain('display_name');
    expect(serializedZip).toContain('portable');
  });

  it('manifest sha256 matches the projected file body contents', async () => {
    mockState.rowsByTable.set('devices', [
      {
        id: 'd1',
        name: 'host-1',
        org_id: '00000000-0000-0000-0000-000000000001',
      },
    ]);
    const { zipBuffer, manifest } = await buildOrgExportZip(
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002',
      undefined,
      FIXTURE_POLICY,
    );

    const zip = await JSZip.loadAsync(zipBuffer);
    const devicesEntry = manifest.files.find((file) => file.name === 'devices.json');
    expect(devicesEntry?.rowCount).toBe(1);

    const devicesContent = await zip.files['devices.json']!.async('string');
    const { createHash } = await import('node:crypto');
    const actualHash = createHash('sha256').update(devicesContent).digest('hex');
    expect(devicesEntry?.sha256).toBe(actualHash);
  });

  it('skips optional cascade tables absent from information_schema', async () => {
    expect(getOrgCascadeDeleteOrder()).toContain('plugins');
    const { manifest } = await buildOrgExportZip(
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002',
      undefined,
      FIXTURE_POLICY,
    );
    expect(manifest.files.map((file) => file.name)).not.toContain('plugins.json');
    expect(mockState.queryLog.some((query) => /FROM\s+"plugins"/i.test(query))).toBe(false);
  });

  it('manifest counts rows from projected per-table query results', async () => {
    mockState.rowsByTable.set('alerts', [
      { id: 'a1', org_id: '00000000-0000-0000-0000-000000000001' },
      { id: 'a2', org_id: '00000000-0000-0000-0000-000000000001' },
      { id: 'a3', org_id: '00000000-0000-0000-0000-000000000001' },
    ]);
    mockState.rowsByTable.set('devices', [
      { id: 'd1', org_id: '00000000-0000-0000-0000-000000000001' },
    ]);
    const { manifest } = await buildOrgExportZip(
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002',
      undefined,
      FIXTURE_POLICY,
    );
    expect(manifest.files.find((file) => file.name === 'alerts.json')?.rowCount).toBe(3);
    expect(manifest.files.find((file) => file.name === 'devices.json')?.rowCount).toBe(1);
    expect(manifest.files.find((file) => file.name === 'organizations.json')?.rowCount).toBe(0);
  });
});
