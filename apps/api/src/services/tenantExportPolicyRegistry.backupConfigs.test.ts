import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { getTableColumns } from 'drizzle-orm';
import { backupConfigs } from '../db/schema/backup';
import { getTenantExportPolicyRegistry } from './tenantExportPolicyRegistry';

/**
 * `backup_configs.encryption_key` was an unused plaintext column; it is
 * dropped by 2026-12-10-100000-drop-backup-configs-encryption-key.sql.
 *
 * The export-policy suites that would catch a stale classification need a
 * live database (Integration Tests only), so the removal is pinned here in
 * **Test API**: the Drizzle schema, the export policy and the migration must
 * agree that the column is gone.
 */
describe('backup_configs.encryption_key is dropped', () => {
  it('is not in the Drizzle schema', () => {
    const names = Object.values(getTableColumns(backupConfigs) as Record<string, { name: string }>).map(
      (column) => column.name,
    );
    expect(names).not.toContain('encryption_key');
    expect(names).toContain('encryption');
  });

  it('is not classified by the tenant export policy', () => {
    const policy = getTenantExportPolicyRegistry()['backup_configs'];
    expect(policy).toBeDefined();
    expect(Object.keys(policy!.columns)).not.toContain('encryption_key');
  });

  it('has a migration that refuses to drop while any row still holds a value', () => {
    const migration = readFileSync(
      new URL('../../migrations/2026-12-10-100000-drop-backup-configs-encryption-key.sql', import.meta.url),
      'utf8',
    );
    expect(migration).toMatch(/set_config\('breeze\.scope',\s*'system',\s*true\)/);
    expect(migration).toMatch(/encryption_key IS NOT NULL/);
    expect(migration).toMatch(/RAISE EXCEPTION/);
    expect(migration).toMatch(/DROP COLUMN IF EXISTS encryption_key/);
  });
});
