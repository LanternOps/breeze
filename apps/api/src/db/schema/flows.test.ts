import { describe, expect, it } from 'vitest';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { flows } from './flows';
import { ORG_CASCADE_DELETE_ORDER } from '../../services/tenantCascade';
import { CORE_TENANT_EXPORT_POLICY } from '../../services/tenantExportPolicyRegistry';
import { getOrgMergePolicies } from '../../services/orgMergeRegistry';

// Tool Catalog W03 (#5218) — the `flows` table. The org-cascade / export /
// merge contracts fail only under Integration Tests; these unit guards make a
// missed registration red in Test API too.
const COLUMNS = [
  'id', 'orgId', 'partnerId', 'slug', 'name', 'description', 'definition',
  'definitionVersion', 'effectiveTier', 'status', 'pausedReason',
  'enabledByUserId', 'enabledAt', 'createdByUserId', 'aiSessionId',
  'managedByAgentId', 'createdAt', 'updatedAt',
] as const;

describe('flows schema', () => {
  it('declares the W3 columns and no webhook secret (Decision 4: W05)', () => {
    expect(getTableName(flows)).toBe('flows');
    const cols = Object.keys(getTableColumns(flows));
    expect(cols.sort()).toEqual([...COLUMNS].sort());
    expect(cols).not.toContain('webhookSecretEncrypted');
    expect(cols).not.toContain('webhookTokenFingerprint');
  });

  it('is registered in the org cascade, export policy and org merge registries', () => {
    expect(ORG_CASCADE_DELETE_ORDER).toContain('flows');
    const policy = CORE_TENANT_EXPORT_POLICY.flows;
    expect(policy).toBeDefined();
    const sqlNames = Object.values(getTableColumns(flows)).map((c) => c.name).sort();
    expect(Object.keys(policy!.columns).sort()).toEqual(sqlNames);
    // jsonb is always excludedOpen.
    expect(policy!.columns.definition!.decision).not.toBe('include');
    expect(getOrgMergePolicies().get('flows')).toEqual(expect.objectContaining({ kind: 'custom' }));
  });
});
