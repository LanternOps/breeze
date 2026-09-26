import { describe, expect, it } from 'vitest';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import * as schema from './index';
import { topologyViewExclusions } from './topology';
import { ORG_CASCADE_DELETE_ORDER } from '../../services/tenantCascade';
import { CORE_TENANT_EXPORT_POLICY } from '../../services/tenantExportPolicyRegistry';
import { getOrgMergePolicies } from '../../services/orgMergeRegistry';

const COLUMNS = [
  'id', 'org_id', 'site_id', 'relationship_id', 'view', 'reason',
  'created_by', 'revoked_at', 'revoked_by', 'created_at', 'updated_at',
];

describe('topology_view_exclusions schema', () => {
  it('declares exactly the scoped reversible exclusion columns', () => {
    expect(getTableName(topologyViewExclusions)).toBe('topology_view_exclusions');
    const cols = getTableColumns(topologyViewExclusions);
    expect(Object.values(cols).map(c => c.name).sort()).toEqual([...COLUMNS].sort());
    for (const name of ['id', 'orgId', 'siteId', 'relationshipId', 'view', 'reason', 'createdAt', 'updatedAt'] as const) {
      expect(cols[name].notNull).toBe(true);
    }
    for (const name of ['createdBy', 'revokedAt', 'revokedBy'] as const) expect(cols[name].notNull).toBe(false);
    expect(cols.reason.getSQLType()).toBe('varchar(500)');
  });

  it('is exported through the schema barrel', () => {
    expect(topologyViewExclusions).toBeDefined();
    expect((schema as Record<string, unknown>).topologyViewExclusions).toBe(topologyViewExclusions);
  });

  it('declares scoped FKs, view/reason checks and the partial active uniqueness', () => {
    const cfg = getTableConfig(topologyViewExclusions);
    const fks = cfg.foreignKeys.map(fk => {
      const ref = fk.reference();
      return { name: fk.getName(), columns: ref.columns.map(c => c.name), foreign: ref.foreignColumns.map(c => c.name), table: getTableName(ref.foreignTable), onDelete: fk.onDelete };
    });
    expect(fks).toEqual(expect.arrayContaining([
      { name: 'topology_view_exclusions_site_scope_fk', columns: ['site_id', 'org_id'], foreign: ['id', 'org_id'], table: 'sites', onDelete: 'cascade' },
      { name: 'topology_view_exclusions_relationship_scope_fk', columns: ['relationship_id', 'org_id', 'site_id'], foreign: ['id', 'org_id', 'site_id'], table: 'topology_relationships', onDelete: 'cascade' },
    ]));
    expect(fks).toHaveLength(2);
    expect(cfg.checks.map(c => c.name).sort()).toEqual(['topology_view_exclusions_reason_chk', 'topology_view_exclusions_view_chk']);
    const active = cfg.indexes.find(i => i.config.name === 'topology_view_exclusions_active_uniq');
    expect(active?.config.unique).toBe(true);
    expect((active?.config.columns as Array<{ name: string }>).map(c => c.name)).toEqual(['org_id', 'site_id', 'relationship_id', 'view']);
    expect(active?.config.where).toBeDefined();
  });

  it('is registered in every org-cascade contract with every column classified', () => {
    expect(ORG_CASCADE_DELETE_ORDER).toContain('topology_view_exclusions');
    const policy = CORE_TENANT_EXPORT_POLICY.topology_view_exclusions;
    expect(policy).toBeDefined();
    expect(Object.keys(policy!.columns).sort()).toEqual([...COLUMNS].sort());
    expect(getOrgMergePolicies().get('topology_view_exclusions')).toEqual({ kind: 'repoint' });
  });
});
