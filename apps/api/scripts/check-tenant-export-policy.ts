import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { closeDb, db } from '../src/db';
import { getOrgCascadeDeleteOrder } from '../src/services/tenantCascade';
import type { TenantExportPolicyRegistry } from '../src/services/tenantExportPolicy';
import { getTenantExportPolicyRegistry } from '../src/services/tenantExportPolicyRegistry';

export type LiveExportColumn = {
  tableName: string;
  columnName: string;
};

export function findTenantExportPolicyIssues(
  tables: readonly string[],
  liveColumns: readonly LiveExportColumn[],
  registry: TenantExportPolicyRegistry,
): string[] {
  const issues: string[] = [];
  const liveByTable = new Map<string, string[]>();
  for (const column of liveColumns) {
    const columns = liveByTable.get(column.tableName) ?? [];
    columns.push(column.columnName);
    liveByTable.set(column.tableName, columns);
  }

  for (const table of tables) {
    const columns = liveByTable.get(table);
    if (!columns || columns.length === 0) continue;
    const policy = registry[table];
    if (!policy) {
      for (const column of columns) {
        issues.push(`${table}.${column}: unclassified`);
      }
      continue;
    }

    const live = new Set(columns);
    const classified = new Set(Object.keys(policy.columns));
    for (const column of columns) {
      if (!classified.has(column)) issues.push(`${table}.${column}: unclassified`);
    }
    for (const column of classified) {
      if (!live.has(column)) issues.push(`${table}.${column}: classification has no live column`);
    }
  }

  return issues;
}

async function main(): Promise<void> {
  const tables = getOrgCascadeDeleteOrder();
  const tableParameters = sql.join(tables.map((table) => sql`${table}`), sql`, `);
  const rows = (await db.execute(sql`
    SELECT
      table_name AS "tableName",
      column_name AS "columnName"
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ANY(ARRAY[${tableParameters}]::text[])
    ORDER BY table_name, ordinal_position
  `)) as unknown as LiveExportColumn[];

  const issues = findTenantExportPolicyIssues(
    tables,
    rows,
    getTenantExportPolicyRegistry(),
  );
  if (issues.length > 0) {
    console.error('[tenant-export-policy] unclassified or stale columns:');
    for (const issue of issues) console.error(`  - ${issue}`);
    process.exitCode = 1;
    return;
  }

  console.log('all cascade tables and columns classified');
}

const entrypoint = process.argv[1] ? resolve(process.argv[1]) : '';
if (entrypoint === fileURLToPath(import.meta.url)) {
  main()
    .catch((error) => {
      console.error('[tenant-export-policy] check failed');
      console.error(error);
      process.exitCode = 2;
    })
    .finally(() => closeDb());
}
