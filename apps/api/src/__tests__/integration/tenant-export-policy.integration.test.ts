import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTestDb } from './setup';
import {
  findTenantExportPolicyIssues,
  type LiveExportColumn,
} from '../../../scripts/check-tenant-export-policy';
import { getOrgCascadeDeleteOrder } from '../../services/tenantCascade';
import { getTenantExportPolicyRegistry } from '../../services/tenantExportPolicyRegistry';

async function readLiveColumns(): Promise<LiveExportColumn[]> {
  const tables = getOrgCascadeDeleteOrder();
  const tableParameters = sql.join(tables.map((table) => sql`${table}`), sql`, `);
  return (await getTestDb().execute(sql`
    SELECT
      table_name AS "tableName",
      column_name AS "columnName"
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ANY(ARRAY[${tableParameters}]::text[])
    ORDER BY table_name, ordinal_position
  `)) as unknown as LiveExportColumn[];
}

describe('tenant export policy registry (live schema)', () => {
  it('classifies every live cascade table column exactly', async () => {
    const tables = getOrgCascadeDeleteOrder();
    const issues = findTenantExportPolicyIssues(
      tables,
      await readLiveColumns(),
      getTenantExportPolicyRegistry(),
    );

    expect(
      issues,
      `Tenant export classifications must exactly match the migration-current schema:\n`
        + issues.join('\n'),
    ).toEqual([]);
  });

  it('fails closed when a new suspicious column has not been reviewed', async () => {
    const db = getTestDb();
    await db.execute(sql`
      ALTER TABLE sites
      ADD COLUMN wave7_unreviewed_secret TEXT
    `);

    try {
      const tables = getOrgCascadeDeleteOrder();
      const issues = findTenantExportPolicyIssues(
        tables,
        await readLiveColumns(),
        getTenantExportPolicyRegistry(),
      );
      expect(issues).toContain('sites.wave7_unreviewed_secret: unclassified');
    } finally {
      await db.execute(sql`
        ALTER TABLE sites
        DROP COLUMN IF EXISTS wave7_unreviewed_secret
      `);
    }
  });
});
