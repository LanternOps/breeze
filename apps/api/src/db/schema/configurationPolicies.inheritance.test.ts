import { describe, expect, it } from 'vitest';
import { getTableColumns, getViewSelectedFields, ViewBaseConfig } from 'drizzle-orm';
import { configurationPolicies, configPolicyEffectiveFeatureLinks } from './configurationPolicies';

describe('configuration policy inheritance schema', () => {
  it('declares parent_policy_id as a nullable uuid', () => {
    const col = getTableColumns(configurationPolicies).parentPolicyId;
    expect(col.name).toBe('parent_policy_id');
    expect(col.notNull).toBe(false);
  });

  it('declares the effective-links view with the contract columns', () => {
    const fields = getViewSelectedFields(configPolicyEffectiveFeatureLinks);
    expect(Object.keys(fields).sort()).toEqual([
      'configPolicyId',
      'createdAt',
      'featurePolicyId',
      'featureType',
      'id',
      'inherited',
      'inlineSettings',
      'sourcePolicyId',
      'updatedAt',
    ]);
  });

  // The view is created and owned by migration
  // 2026-10-12-100000-config-policy-inheritance.sql. `.existing()` is what
  // keeps drizzle-kit from trying to manage (or drop) it — losing it would
  // strip `security_invoker` and turn the view into an RLS bypass.
  it('marks the view as existing, with no drizzle-side definition', () => {
    const config = (configPolicyEffectiveFeatureLinks as unknown as Record<
      typeof ViewBaseConfig,
      { name: string; isExisting: boolean; query: unknown }
    >)[ViewBaseConfig];
    expect(config.name).toBe('config_policy_effective_feature_links');
    expect(config.isExisting).toBe(true);
    // No query attached — the SQL body lives only in the migration, so
    // drizzle-kit has nothing it could regenerate.
    expect(config.query).toBeUndefined();
  });
});
