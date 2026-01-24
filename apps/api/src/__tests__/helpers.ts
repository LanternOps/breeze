import type { Context } from 'hono';
import { Hono } from 'hono';
import { createAccessToken, type TokenPayload } from '../services/jwt';

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

export interface TestTokenOptions {
  userId?: string;
  email?: string;
  roleId?: string | null;
  orgId?: string | null;
  partnerId?: string | null;
  scope?: 'system' | 'partner' | 'organization';
}

export async function createTestToken(options: TestTokenOptions = {}): Promise<string> {
  const payload: Omit<TokenPayload, 'type'> = {
    sub: options.userId ?? 'test-user-id',
    email: options.email ?? 'test@example.com',
    roleId: options.roleId ?? 'test-role-id',
    orgId: options.orgId ?? 'test-org-id',
    partnerId: options.partnerId ?? 'test-partner-id',
    scope: options.scope ?? 'organization'
  };
  return createAccessToken(payload);
}

export interface AuthenticatedTestClient {
  token: string;
  get: (path: string) => Promise<Response>;
  post: (path: string, body?: unknown) => Promise<Response>;
  patch: (path: string, body?: unknown) => Promise<Response>;
  put: (path: string, body?: unknown) => Promise<Response>;
  delete: (path: string) => Promise<Response>;
}

export async function createAuthenticatedClient(
  app: Hono,
  tokenOptions: TestTokenOptions = {}
): Promise<AuthenticatedTestClient> {
  const token = await createTestToken(tokenOptions);

  const makeRequest = async (
    method: string,
    path: string,
    body?: unknown
  ): Promise<Response> => {
    const options: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    };
    if (body !== undefined) {
      options.body = JSON.stringify(body);
    }
    return app.request(path, options);
  };

  return {
    token,
    get: (path: string) => makeRequest('GET', path),
    post: (path: string, body?: unknown) => makeRequest('POST', path, body),
    patch: (path: string, body?: unknown) => makeRequest('PATCH', path, body),
    put: (path: string, body?: unknown) => makeRequest('PUT', path, body),
    delete: (path: string) => makeRequest('DELETE', path)
  };
}

export function createTestDevice(overrides: Record<string, unknown> = {}) {
  return {
    id: 'test-device-id',
    orgId: 'test-org-id',
    siteId: 'test-site-id',
    agentId: 'agent-123',
    hostname: 'test-host',
    displayName: 'Test Device',
    osType: 'linux',
    osVersion: '22.04',
    osBuild: 'build-1',
    architecture: 'x86_64',
    agentVersion: '1.0.0',
    status: 'online',
    lastSeenAt: new Date(),
    enrolledAt: new Date(),
    tags: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides
  };
}

export function createTestSite(overrides: Record<string, unknown> = {}) {
  return {
    id: 'test-site-id',
    orgId: 'test-org-id',
    name: 'Test Site',
    address: '123 Test St',
    timezone: 'UTC',
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides
  };
}
