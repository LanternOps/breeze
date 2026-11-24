import { describe, it, expect } from 'vitest';
import { copyConfigPolicySchema, CONFIG_POLICY_COPY_DROP_REASONS } from './index';

const UUID = '550e8400-e29b-41d4-a716-446655440000';

describe('copyConfigPolicySchema (#12309, #11776)', () => {
  it('accepts a same-owner copy with only a name and an owner', () => {
    expect(copyConfigPolicySchema.safeParse({ name: 'Servers (copy)', ownerScope: 'organization' }).success).toBe(true);
  });

  it('accepts another organization, an explicit parent, no parent and a dry run', () => {
    expect(copyConfigPolicySchema.safeParse({ name: 'A', ownerScope: 'organization', orgId: UUID, parentPolicyId: UUID, dryRun: true }).success).toBe(true);
    expect(copyConfigPolicySchema.safeParse({ name: 'A', ownerScope: 'partner', parentPolicyId: null }).success).toBe(true);
  });

  it('refuses an empty or over-long name, an unknown owner and a malformed id', () => {
    expect(copyConfigPolicySchema.safeParse({ name: '', ownerScope: 'organization' }).success).toBe(false);
    expect(copyConfigPolicySchema.safeParse({ name: 'x'.repeat(256), ownerScope: 'organization' }).success).toBe(false);
    expect(copyConfigPolicySchema.safeParse({ name: 'A', ownerScope: 'site' }).success).toBe(false);
    expect(copyConfigPolicySchema.safeParse({ name: 'A', ownerScope: 'organization', orgId: 'nope' }).success).toBe(false);
  });

  it('has no status and no assignments: a copy is always inactive and unapplied', () => {
    const parsed = copyConfigPolicySchema.parse({
      name: 'A', ownerScope: 'organization', status: 'active', assignments: [{ level: 'organization' }],
    } as Record<string, unknown>);
    expect(parsed).not.toHaveProperty('status');
    expect(parsed).not.toHaveProperty('assignments');
  });

  it('names a closed set of drop reasons', () => {
    expect([...CONFIG_POLICY_COPY_DROP_REASONS]).toEqual(['org_only_feature', 'linked_item_unavailable', 'settings_not_valid']);
  });
});
