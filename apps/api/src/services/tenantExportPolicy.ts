import { sql } from 'drizzle-orm';
import { db } from '../db';

export type ExportColumnDecision = {
  decision: 'include' | 'exclude';
  rationale: string;
  reviewedSensitiveName?: true;
  openContainerReviewed?: true;
};

export type TenantExportTablePolicy = {
  organizationKey: 'id' | 'org_id';
  columns: Readonly<Record<string, ExportColumnDecision>>;
};

export type TenantExportPolicyRegistry =
  Readonly<Record<string, TenantExportTablePolicy>>;

export type ExportTablePlan = {
  table: string;
  organizationKey: 'id' | 'org_id';
  includedColumns: readonly string[];
};

type InformationSchemaColumn = {
  tableName: string;
  columnName: string;
  dataType: string;
  udtName: string;
  ordinalPosition: number;
};

const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/i;

const SUSPICIOUS_NAME_PARTS = [
  'password',
  'hash',
  'mfa',
  'totp',
  'recovery',
  'token',
  'secret',
  'private_key',
  'credential',
  'authorization',
  'cookie',
  'webhook',
  'encryption_key',
  'provision',
  'bootstrap',
  'invite',
  'refresh',
  'access_key',
  'client_key',
] as const;

const OPEN_CONTAINER_NAMES = new Set([
  'credentials',
  'headers',
  'config',
  'settings',
  'metadata',
  'payload',
  'data',
  'blob',
  'opaque',
]);

const OPEN_CONTAINER_TYPES = new Set(['json', 'jsonb', 'bytea']);

function assertSafeIdentifier(identifier: string): void {
  if (!SAFE_IDENTIFIER.test(identifier)) {
    throw new Error(
      `[tenantExport] refusing unsafe identifier "${identifier}"`,
    );
  }
}

function assertNoDuplicates(values: readonly string[], kind: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`[tenantExport] duplicate ${kind} "${value}"`);
    }
    seen.add(value);
  }
}

function isSuspiciousColumnName(columnName: string): boolean {
  const normalized = columnName.toLowerCase();
  return SUSPICIOUS_NAME_PARTS.some((part) => normalized.includes(part));
}

function isOpenContainer(column: InformationSchemaColumn): boolean {
  return OPEN_CONTAINER_NAMES.has(column.columnName.toLowerCase())
    || OPEN_CONTAINER_TYPES.has(column.dataType.toLowerCase())
    || OPEN_CONTAINER_TYPES.has(column.udtName.toLowerCase());
}

function expectedOrganizationKey(
  table: string,
  liveColumnNames: ReadonlySet<string>,
): 'id' | 'org_id' {
  if (liveColumnNames.has('org_id')) return 'org_id';
  if (liveColumnNames.has('id')) return 'id';
  throw new Error(
    `[tenantExport] table "${table}" has neither an org_id nor id organization key`,
  );
}

function describeColumnMismatch(
  table: string,
  missing: readonly string[],
  extra: readonly string[],
): string {
  const parts = [`[tenantExport] policy columns do not match live table "${table}"`];
  if (missing.length > 0) parts.push(`missing classifications: ${missing.join(', ')}`);
  if (extra.length > 0) parts.push(`extra classifications: ${extra.join(', ')}`);
  return parts.join('; ');
}

/**
 * Classify the complete live cascade schema before any tenant-row query.
 *
 * The concrete registry is deliberately injected. This module owns the
 * fail-closed classifier and has no dependency on the checked-in core or
 * extension registry.
 */
export async function buildTenantExportPlan(
  tables: readonly string[],
  registry: TenantExportPolicyRegistry,
): Promise<readonly ExportTablePlan[]> {
  assertNoDuplicates(tables, 'table');
  for (const table of tables) assertSafeIdentifier(table);
  if (tables.length === 0) return [];
  const tableParameters = sql.join(tables.map((table) => sql`${table}`), sql`, `);

  const rows = (await db.execute(sql`
    SELECT
      table_name AS "tableName",
      column_name AS "columnName",
      data_type AS "dataType",
      udt_name AS "udtName",
      ordinal_position AS "ordinalPosition"
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ANY(ARRAY[${tableParameters}]::text[])
    ORDER BY table_name, ordinal_position
  `)) as unknown as InformationSchemaColumn[];

  const columnsByTable = new Map<string, InformationSchemaColumn[]>();
  for (const row of rows) {
    assertSafeIdentifier(row.tableName);
    assertSafeIdentifier(row.columnName);
    if (!tables.includes(row.tableName)) {
      throw new Error(
        `[tenantExport] information schema returned unexpected table "${row.tableName}"`,
      );
    }
    const existing = columnsByTable.get(row.tableName) ?? [];
    existing.push(row);
    columnsByTable.set(row.tableName, existing);
  }

  const plan: ExportTablePlan[] = [];
  for (const table of tables) {
    const liveColumns = columnsByTable.get(table);
    if (!liveColumns || liveColumns.length === 0) {
      // Optional extension/deployment table is absent from this database.
      continue;
    }

    assertNoDuplicates(
      liveColumns.map((column) => column.columnName),
      `column in "${table}"`,
    );

    const policy = registry[table];
    if (!policy) {
      throw new Error(`[tenantExport] table "${table}" is missing an export policy`);
    }

    const liveColumnNames = liveColumns.map((column) => column.columnName);
    const liveColumnSet = new Set(liveColumnNames);
    const expectedKey = expectedOrganizationKey(table, liveColumnSet);
    if (policy.organizationKey !== expectedKey) {
      throw new Error(
        `[tenantExport] wrong organization key for "${table}": `
          + `expected "${expectedKey}", received "${policy.organizationKey}"`,
      );
    }

    const policyColumnNames = Object.keys(policy.columns);
    for (const columnName of policyColumnNames) assertSafeIdentifier(columnName);

    const policyColumnSet = new Set(policyColumnNames);
    const missing = liveColumnNames.filter((name) => !policyColumnSet.has(name));
    const extra = policyColumnNames.filter((name) => !liveColumnSet.has(name));
    if (missing.length > 0 || extra.length > 0) {
      throw new Error(describeColumnMismatch(table, missing, extra));
    }

    const includedColumns: string[] = [];
    for (const column of [...liveColumns].sort(
      (left, right) => left.ordinalPosition - right.ordinalPosition,
    )) {
      const decision = policy.columns[column.columnName]!;
      if (decision.rationale.trim().length === 0) {
        throw new Error(
          `[tenantExport] column "${table}.${column.columnName}" has no rationale`,
        );
      }
      if (
        decision.decision === 'include'
        && isSuspiciousColumnName(column.columnName)
        && decision.reviewedSensitiveName !== true
      ) {
        throw new Error(
          `[tenantExport] suspicious include "${table}.${column.columnName}" `
            + 'requires reviewedSensitiveName: true',
        );
      }
      if (isOpenContainer(column) && decision.openContainerReviewed !== true) {
        throw new Error(
          `[tenantExport] open container "${table}.${column.columnName}" `
            + 'requires openContainerReviewed: true',
        );
      }
      if (decision.decision === 'include') includedColumns.push(column.columnName);
    }

    if (!includedColumns.includes(policy.organizationKey)) {
      throw new Error(
        `[tenantExport] organization key "${table}.${policy.organizationKey}" `
          + 'must be included',
      );
    }

    plan.push({
      table,
      organizationKey: policy.organizationKey,
      includedColumns,
    });
  }

  return plan;
}
