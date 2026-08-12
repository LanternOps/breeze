import { describe, expect, it } from 'vitest';
import {
  createTenantVariableSchema,
  updateTenantVariableSchema,
  MAX_TENANT_VARIABLE_VALUE_LENGTH
} from './tenantVariables';

const valid = { ownerScope: 'organization' as const, key: 's1_site_token', value: 'abc123' };

describe('createTenantVariableSchema', () => {
  it('accepts a minimal org-scoped variable and defaults isSecret to false', () => {
    expect(createTenantVariableSchema.parse(valid)).toMatchObject({ key: 's1_site_token', isSecret: false });
  });

  it('accepts a partner-wide variable', () => {
    expect(createTenantVariableSchema.parse({ ...valid, ownerScope: 'partner' }).ownerScope).toBe('partner');
  });

  it.each(['Bad_Key', 'has space', '9leading', 'trailing-dash', 'has.dot', 'UPPER', '', 'a'.repeat(65)])(
    'rejects key %j',
    (key) => {
      expect(createTenantVariableSchema.safeParse({ ...valid, key }).success).toBe(false);
    }
  );

  it.each(['a', 'a_b_9', 'a'.repeat(64)])('accepts key %j', (key) => {
    expect(createTenantVariableSchema.safeParse({ ...valid, key }).success).toBe(true);
  });

  it('rejects an empty or oversized value', () => {
    expect(createTenantVariableSchema.safeParse({ ...valid, value: '' }).success).toBe(false);
    expect(
      createTenantVariableSchema.safeParse({ ...valid, value: 'a'.repeat(MAX_TENANT_VARIABLE_VALUE_LENGTH + 1) }).success
    ).toBe(false);
    expect(
      createTenantVariableSchema.safeParse({ ...valid, value: 'a'.repeat(MAX_TENANT_VARIABLE_VALUE_LENGTH) }).success
    ).toBe(true);
  });

  it('requires a value — a variable with nothing in it is meaningless', () => {
    const { value, ...withoutValue } = valid;
    expect(createTenantVariableSchema.safeParse(withoutValue).success).toBe(false);
  });

  it('rejects an unknown owner scope and a malformed orgId', () => {
    expect(createTenantVariableSchema.safeParse({ ...valid, ownerScope: 'site' }).success).toBe(false);
    expect(createTenantVariableSchema.safeParse({ ...valid, orgId: 'not-a-uuid' }).success).toBe(false);
  });

  it('rejects an oversized description', () => {
    expect(createTenantVariableSchema.safeParse({ ...valid, description: 'a'.repeat(501) }).success).toBe(false);
  });
});

describe('updateTenantVariableSchema', () => {
  it('drops ownership and key — neither is mutable', () => {
    const parsed = updateTenantVariableSchema.parse({
      ownerScope: 'partner',
      orgId: '00000000-0000-0000-0000-000000000001',
      key: 'renamed',
      description: 'still editable'
    });
    expect(parsed).toEqual({ description: 'still editable' });
  });

  it('an empty update materializes NO fields — omission must never clobber stored state', () => {
    // Guards the Zod 4 trap where .partial() does not suppress a .default():
    // an isSecret default here would silently un-secret an existing variable.
    expect(updateTenantVariableSchema.parse({})).toEqual({});
  });

  it('accepts a description clear via explicit null', () => {
    expect(updateTenantVariableSchema.parse({ description: null })).toEqual({ description: null });
  });

  it('still enforces the value bounds', () => {
    expect(updateTenantVariableSchema.safeParse({ value: '' }).success).toBe(false);
    expect(
      updateTenantVariableSchema.safeParse({ value: 'a'.repeat(MAX_TENANT_VARIABLE_VALUE_LENGTH + 1) }).success
    ).toBe(false);
  });
});
