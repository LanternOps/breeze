import type { Context } from 'hono';

export interface MockAuthContext {
  userId: string;
  email: string;
  roleId: string | null;
  orgId: string | null;
  partnerId: string | null;
  scope: 'system' | 'partner' | 'organization';
}

export function createMockAuth(overrides: Partial<MockAuthContext> = {}): MockAuthContext {
  return {
    userId: 'test-user-id',
    email: 'test@example.com',
    roleId: 'test-role-id',
    orgId: 'test-org-id',
    partnerId: 'test-partner-id',
    scope: 'organization',
    ...overrides
  };
}

export function createTestUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'test-user-id',
    email: 'test@example.com',
    name: 'Test User',
    status: 'active',
    mfaEnabled: false,
    mfaSecret: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides
  };
}

export function createTestOrganization(overrides: Record<string, unknown> = {}) {
  return {
    id: 'test-org-id',
    name: 'Test Organization',
    partnerId: 'test-partner-id',
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides
  };
}
