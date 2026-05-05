/**
 * Database Test Utilities
 *
 * Factory functions and utilities for creating test data in integration tests.
 * All functions insert real data into the test database.
 *
 * Note: Type assertions are used here because these are integration tests
 * that will catch any actual type errors at runtime against a real database.
 */
import { getTestDb } from './setup';
import { hashPassword } from '../../services/password';
import { createAccessToken, type TokenPayload } from '../../services/jwt';
import {
  users,
  roles,
  partners,
  organizations,
  sites,
  partnerUsers,
  organizationUsers
} from '../../db/schema';

// Use any for database to avoid complex type inference issues in tests
// Runtime errors will be caught by actual integration test execution
function db() {
  return getTestDb() as any;
}

// ============================================
// User Utilities
// ============================================

export interface CreateUserOptions {
  /** The MSP (partner) this user belongs to. Required — users.partner_id is NOT NULL. */
  partnerId: string;
  /** Customer org the user is primarily a member of. Null/undefined = MSP staff. */
  orgId?: string | null;
  email?: string;
  name?: string;
  password?: string;
  status?: 'active' | 'invited' | 'disabled';
  mfaEnabled?: boolean;
}

export async function createUser(options: CreateUserOptions) {
  const database = db();
  const passwordHash = await hashPassword(options.password || 'TestPass123!');

  const [user] = await database
    .insert(users)
    .values({
      partnerId: options.partnerId,
      orgId: options.orgId ?? null,
      email: options.email || `test-${Date.now()}@example.com`,
      name: options.name || 'Test User',
      passwordHash,
      status: options.status || 'active',
      mfaEnabled: options.mfaEnabled || false
    })
    .returning();

  return user;
}

// ============================================
// Partner Utilities
// ============================================

export interface CreatePartnerOptions {
  name?: string;
  slug?: string;
  type?: 'msp' | 'enterprise' | 'internal';
  plan?: 'free' | 'pro' | 'enterprise' | 'unlimited';
  /** Defaults to 'active'. Use 'suspended' / 'churned' / 'pending' to test the tenant-status gate. */
  status?: 'pending' | 'active' | 'suspended' | 'churned';
  /** Set to a Date to soft-delete the partner (drives the deletedAt branch in tenantStatus.ts). */
  deletedAt?: Date | null;
}

export async function createPartner(options: CreatePartnerOptions = {}) {
  const database = db();
  const timestamp = Date.now();
  // Random suffix prevents slug collisions when multiple partners are created
  // within the same millisecond in a single test (status-gate suite needs a
  // suspended partner + an active partner side-by-side).
  const rand = Math.random().toString(36).slice(2, 8);

  const [partner] = await database
    .insert(partners)
    .values({
      name: options.name || `Test Partner ${timestamp}-${rand}`,
      slug: options.slug || `test-partner-${timestamp}-${rand}`,
      type: options.type || 'msp',
      plan: options.plan || 'pro',
      status: options.status || 'active',
      deletedAt: options.deletedAt ?? null
    })
    .returning();

  return partner;
}

// ============================================
// Organization Utilities
// ============================================

export interface CreateOrganizationOptions {
  partnerId: string;
  name?: string;
  slug?: string;
  type?: 'customer' | 'internal';
  status?: 'active' | 'suspended' | 'trial' | 'churned';
  /** Set to a Date to soft-delete the org (drives the deletedAt branch in tenantStatus.ts). */
  deletedAt?: Date | null;
}

export async function createOrganization(options: CreateOrganizationOptions) {
  const database = db();
  const timestamp = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);

  const [org] = await database
    .insert(organizations)
    .values({
      partnerId: options.partnerId,
      name: options.name || `Test Organization ${timestamp}-${rand}`,
      slug: options.slug || `test-org-${timestamp}-${rand}`,
      type: options.type || 'customer',
      status: options.status || 'active',
      deletedAt: options.deletedAt ?? null
    })
    .returning();

  return org;
}

// ============================================
// Site Utilities
// ============================================

export interface CreateSiteOptions {
  orgId: string;
  name?: string;
  timezone?: string;
}

export async function createSite(options: CreateSiteOptions) {
  const database = db();
  const timestamp = Date.now();

  const [site] = await database
    .insert(sites)
    .values({
      orgId: options.orgId,
      name: options.name || `Test Site ${timestamp}`,
      timezone: options.timezone || 'UTC'
    })
    .returning();

  return site;
}

// ============================================
// Role Utilities
// ============================================

export interface CreateRoleOptions {
  name?: string;
  scope: 'system' | 'partner' | 'organization';
  partnerId?: string;
  orgId?: string;
  isSystem?: boolean;
}

export async function createRole(options: CreateRoleOptions) {
  const database = db();
  const timestamp = Date.now();

  const [role] = await database
    .insert(roles)
    .values({
      name: options.name || `Test Role ${timestamp}`,
      scope: options.scope,
      partnerId: options.partnerId,
      orgId: options.orgId,
      isSystem: options.isSystem || false
    })
    .returning();

  return role;
}

// ============================================
// User Assignment Utilities
// ============================================

export async function assignUserToPartner(
  userId: string,
  partnerId: string,
  roleId: string,
  orgAccess: 'all' | 'selected' | 'none' = 'all'
) {
  const database = db();

  const [assignment] = await database
    .insert(partnerUsers)
    .values({
      userId,
      partnerId,
      roleId,
      orgAccess
    })
    .returning();

  return assignment;
}

export async function assignUserToOrganization(
  userId: string,
  orgId: string,
  roleId: string
) {
  const database = db();

  const [assignment] = await database
    .insert(organizationUsers)
    .values({
      userId,
      orgId,
      roleId
    })
    .returning();

  return assignment;
}

// ============================================
// Complete Test Environment Setup
// ============================================

export interface TestEnvironment {
  user: Awaited<ReturnType<typeof createUser>>;
  partner: Awaited<ReturnType<typeof createPartner>>;
  organization: Awaited<ReturnType<typeof createOrganization>>;
  site: Awaited<ReturnType<typeof createSite>>;
  role: Awaited<ReturnType<typeof createRole>>;
  token: string;
}

export interface SetupTestEnvironmentOptions {
  // partnerId/orgId are derived from the partner + organization created
  // inside setupTestEnvironment, so callers only supply overrides for the
  // optional fields.
  userOptions?: Partial<Omit<CreateUserOptions, 'partnerId' | 'orgId'>>;
  partnerOptions?: CreatePartnerOptions;
  scope?: 'system' | 'partner' | 'organization';
}

/**
 * Creates a complete test environment with:
 * - A user
 * - A partner
 * - An organization under the partner
 * - A site under the organization
 * - A role with the specified scope
 * - User assigned to the appropriate level
 * - A valid JWT token
 */
export async function setupTestEnvironment(
  options: SetupTestEnvironmentOptions = {}
): Promise<TestEnvironment> {
  const scope = options.scope || 'organization';

  // Create base entities. Partner/organization must exist before the
  // user so we can populate users.partner_id / users.org_id correctly —
  // partner-scope tests create an MSP staff user (partner_id set, org_id
  // null); org-scope tests create a customer-org user (both set).
  const partner = await createPartner(options.partnerOptions);
  const organization = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: organization.id });
  const user = await createUser({
    partnerId: partner.id,
    orgId: scope === 'organization' ? organization.id : null,
    ...options.userOptions,
  });

  // Create role with appropriate scope
  const role = await createRole({
    scope,
    partnerId: scope === 'partner' ? partner.id : undefined,
    orgId: scope === 'organization' ? organization.id : undefined
  });

  // Assign user based on scope
  if (scope === 'partner') {
    await assignUserToPartner(user.id, partner.id, role.id, 'all');
  } else if (scope === 'organization') {
    await assignUserToOrganization(user.id, organization.id, role.id);
  }

  // Create JWT token
  const tokenPayload: Omit<TokenPayload, 'type'> = {
    sub: user.id,
    email: user.email,
    roleId: role.id,
    orgId: scope === 'organization' ? organization.id : null,
    partnerId: scope !== 'system' ? partner.id : null,
    scope,
    mfa: false
  };
  const token = await createAccessToken(tokenPayload);

  return {
    user,
    partner,
    organization,
    site,
    role,
    token
  };
}

// ============================================
// Authenticated Request Helper
// ============================================

import { Hono } from 'hono';

export interface IntegrationTestClient {
  token: string;
  env: TestEnvironment;
  get: (path: string) => Promise<Response>;
  post: (path: string, body?: unknown) => Promise<Response>;
  patch: (path: string, body?: unknown) => Promise<Response>;
  put: (path: string, body?: unknown) => Promise<Response>;
  delete: (path: string) => Promise<Response>;
}

/**
 * Creates an authenticated test client with a full test environment.
 * Use this for integration tests that need a real database.
 */
export async function createIntegrationTestClient(
  app: Hono,
  options: SetupTestEnvironmentOptions = {}
): Promise<IntegrationTestClient> {
  const env = await setupTestEnvironment(options);

  const makeRequest = async (
    method: string,
    path: string,
    body?: unknown
  ): Promise<Response> => {
    const requestOptions: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${env.token}`,
        'Content-Type': 'application/json'
      }
    };
    if (body !== undefined) {
      requestOptions.body = JSON.stringify(body);
    }
    return app.request(path, requestOptions);
  };

  return {
    token: env.token,
    env,
    get: (path: string) => makeRequest('GET', path),
    post: (path: string, body?: unknown) => makeRequest('POST', path, body),
    patch: (path: string, body?: unknown) => makeRequest('PATCH', path, body),
    put: (path: string, body?: unknown) => makeRequest('PUT', path, body),
    delete: (path: string) => makeRequest('DELETE', path)
  };
}
