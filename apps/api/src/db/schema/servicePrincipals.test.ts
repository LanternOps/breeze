import { describe, it, expect } from 'vitest';
import { servicePrincipals } from './servicePrincipals';
import { apiKeys } from './apiKeys';

describe('servicePrincipals schema', () => {
  it('exposes the org-owned identity columns (SR2-15)', () => {
    expect(servicePrincipals.orgId).toBeDefined();
    expect(servicePrincipals.status).toBeDefined();
    expect(servicePrincipals.scopes).toBeDefined();
  });

  it('defaults status to active and scopes to an empty array', () => {
    expect(servicePrincipals.status.default).toBe('active');
    expect(servicePrincipals.scopes.default).toEqual([]);
  });

  it('carries audit columns for who created/last-updated it', () => {
    expect(servicePrincipals.createdBy).toBeDefined();
    expect(servicePrincipals.lastUpdatedBy).toBeDefined();
  });
});

describe('apiKeys schema principal columns (SR2-15)', () => {
  it('exposes principalType defaulting to human, and a nullable principalId', () => {
    expect(apiKeys.principalType).toBeDefined();
    expect(apiKeys.principalType.default).toBe('human');
    expect(apiKeys.principalId).toBeDefined();
    expect(apiKeys.principalId.notNull).toBe(false);
  });
});
