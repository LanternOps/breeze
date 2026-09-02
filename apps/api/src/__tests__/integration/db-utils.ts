/**
 * Database Test Utilities
 *
 * Factory functions and utilities for creating test data in integration tests.
 * All functions insert real data into the test database.
 *
 * Note: Type assertions are used here because these are integration tests
 * that will catch any actual type errors at runtime against a real database.
 */
import { randomUUID } from 'crypto';
import { getTestDb, type TestDatabase } from './setup';
import { hashPassword } from '../../services/password';
import { createAccessToken, type TokenPayload } from '../../services/jwt';
import {
  users,
  roles,
  partners,
  organizations,
  sites,
  partnerUsers,
  organizationUsers,
  permissions,
  rolePermissions,
  catalogItems,
  catalogItemPrices
} from '../../db/schema';
import { and, eq, sql } from 'drizzle-orm';

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
  /**
   * Also create a tenant membership (organization_users when orgId is set, else
   * partner_users) plus a minimal role, so the user can actually log in. Token
   * issuance now requires a membership — a membership-less non-admin is rejected
   * (security review #2 / resolveCurrentUserTokenContext). Default false to keep
   * the many RLS/isolation fixtures (which only need the `users` row) unchanged.
   */
  withMembership?: boolean;
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

  if (options.withMembership) {
    if (options.orgId) {
      const role = await createRole({ scope: 'organization', orgId: options.orgId, partnerId: options.partnerId });
      await assignUserToOrganization(user.id, options.orgId, role.id);
    } else {
      const role = await createRole({ scope: 'partner', partnerId: options.partnerId });
      await assignUserToPartner(user.id, options.partnerId, role.id, 'all');
    }
  }

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
  /** ISO-4217 partner default currency (multi-currency). Defaults to 'USD'. */
  currencyCode?: string;
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
      deletedAt: options.deletedAt ?? null,
      currencyCode: options.currencyCode ?? 'USD'
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
  /** ISO-4217 org billing currency (multi-currency wave 1). Defaults to 'USD'. */
  currencyCode?: string;
}

export async function createOrganization(options: CreateOrganizationOptions) {
  const database = db();
  const timestamp = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);

  const [org] = await database
    .insert(organizations)
    .values({
      partnerId: options.partnerId,
      currencyCode: options.currencyCode ?? 'USD',
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
// Catalog Utilities
// ============================================

export interface CreateCatalogItemWithPriceOptions {
  partnerId: string;
  name: string;
  /** Currency of the single price-book row. */
  currencyCode: string;
  unitPrice: string;
  costBasis?: string | null;
  /** Defaults to currencyCode. */
  costCurrency?: string;
  itemType?: 'hardware' | 'software' | 'service';
}

/**
 * Insert a catalog item plus ONE catalog_item_prices row (multi-currency wave
 * 3). Document services resolve sell prices from the price book, never from
 * the deprecated catalog_items.unit_price mirror, so a fixture item with no
 * price-book row hits NO_PRICE_FOR_CURRENCY when a line is added from it.
 * Caller supplies the DB context (system scope for seeds).
 */
export async function createCatalogItemWithPrice(opts: CreateCatalogItemWithPriceOptions): Promise<{ id: string }> {
  const database = db();
  const [item] = await database
    .insert(catalogItems)
    .values({
      partnerId: opts.partnerId,
      itemType: opts.itemType ?? 'service',
      name: opts.name,
      unitPrice: opts.unitPrice,
      costBasis: opts.costBasis ?? null,
      costCurrency: opts.costCurrency ?? opts.currencyCode,
      billingType: 'one_time',
      taxable: true,
      isBundle: false
    })
    .returning({ id: catalogItems.id });
  if (!item) throw new Error('createCatalogItemWithPrice: item insert returned no row');
  await database.insert(catalogItemPrices).values({
    itemId: item.id,
    partnerId: opts.partnerId,
    currencyCode: opts.currencyCode,
    unitPrice: opts.unitPrice
  });
  return { id: item.id };
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

/**
 * Grant resource/action permissions to a role through the real
 * permissions catalog + role_permissions join (the same tables
 * getUserPermissions resolves at request time). Rows in the global
 * `permissions` catalog are found-or-created so repeated runs stay
 * idempotent regardless of whether cleanup truncates the catalog.
 */
export async function grantRolePermissions(
  roleId: string,
  perms: Array<{ resource: string; action: string }>
) {
  const database = db();

  for (const perm of perms) {
    let [permissionRow] = await database
      .select({ id: permissions.id })
      .from(permissions)
      .where(and(eq(permissions.resource, perm.resource), eq(permissions.action, perm.action)))
      .limit(1);

    if (!permissionRow) {
      [permissionRow] = await database
        .insert(permissions)
        .values({
          resource: perm.resource,
          action: perm.action,
          description: 'integration test grant'
        })
        .returning({ id: permissions.id });
    }

    await database.insert(rolePermissions).values({
      roleId,
      permissionId: permissionRow.id
    });
  }
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
  /**
   * Overrides for the organization created by setupTestEnvironment — notably
   * `currencyCode`, so an HTTP-level test can seed a non-USD org without a
   * post-hoc `UPDATE organizations SET currency_code` (multi-currency #3778).
   */
  organizationOptions?: Partial<Omit<CreateOrganizationOptions, 'partnerId'>>;
  scope?: 'system' | 'partner' | 'organization';
  /**
   * Permissions granted to the created role. Defaults to a `*`/`*` wildcard
   * so the client passes `requirePermission` gates the way a real admin role
   * would (production seeds grant every device-viewing role DEVICES_READ
   * etc. — a role with zero permission rows only exists in tests). Pass an
   * explicit array (or `[]` for a permissionless role) to test RBAC denials.
   */
  rolePermissions?: Array<{ resource: string; action: string }>;
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
  const organization = await createOrganization({
    partnerId: partner.id,
    ...options.organizationOptions,
  });
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

  // Grant permissions so requirePermission-gated routes behave as they do
  // for a real seeded role (wildcard by default; see option docs).
  await grantRolePermissions(
    role.id,
    options.rolePermissions ?? [{ resource: '*', action: '*' }]
  );

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
    mfa: false,
    // Seeded fixture users keep the DB default auth_epoch/mfa_epoch = 1
    // (see users.ts), so the minted token matches the live row. sid must
    // be non-empty — Task 8's authMiddleware rejects sid-less access
    // tokens.
    aep: 1,
    mep: 1,
    sid: randomUUID()
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

// ============================================
// Deferrable-FK Replay Restoration
// ============================================

/**
 * Restores the org-lifecycle deferrable-FK contract
 * (`migrations/2026-09-12-100001-org-lifecycle-foundations.sql` Section 2):
 * every composite FK referencing an `org_id` column must be
 * `DEFERRABLE INITIALLY IMMEDIATE`, because the org-merge transaction
 * (Wave 2) runs `SET CONSTRAINTS ALL DEFERRED` and re-points parent+child
 * `org_id` in separate statements — a non-deferrable composite FK breaks it.
 * `orgLifecycleFoundations.integration.test.ts` asserts this against live
 * `pg_constraint` state at test-run time, so it cannot distinguish "never
 * fixed" from "fixed, then un-fixed by a later migration replay in the same
 * shared test DB."
 *
 * A handful of already-shipped migrations, replayed raw by other integration
 * suites for their own idempotency/regression coverage, unconditionally
 * recreate a composite `org_id` FK non-deferrable — an unguarded
 * `ALTER CONSTRAINT ... NOT DEFERRABLE` in the partner-export material-state
 * hardening migration, and unconditional `DROP CONSTRAINT` + `ADD CONSTRAINT`
 * (with no `DEFERRABLE` clause) in the m365 graph-read-consent and
 * agent-originated-intents migrations. Per CLAUDE.md, never edit a shipped
 * migration to "fix" this — and never re-run the org-lifecycle migration's DO
 * block from inside `orgLifecycleFoundations.integration.test.ts` itself,
 * which would silently paper over genuinely new non-deferrable composite FKs
 * from unrelated future PRs. Instead, every suite that replays one of these
 * migrations raw must call this helper immediately after, to restore the
 * contract the replay just undid.
 *
 * The DO block below is copied verbatim from that migration file's Section 2
 * — keep it in sync if that block ever changes.
 */
export async function reapplyOrgIdFkDeferrability(db: TestDatabase = getTestDb()): Promise<void> {
  await db.execute(sql`
    DO $$
    DECLARE
      fk record;
      n integer := 0;
    BEGIN
      FOR fk IN
        SELECT con.conname, con.conrelid::regclass AS child_table
        FROM pg_constraint con
        WHERE con.contype = 'f'
          AND con.condeferrable = false
          AND con.connamespace = 'public'::regnamespace
          AND EXISTS (
            SELECT 1 FROM unnest(con.confkey) AS ck(attnum)
            JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = ck.attnum
            WHERE a.attname = 'org_id'
          )
        ORDER BY con.conrelid::regclass::text, con.conname
      LOOP
        EXECUTE format('ALTER TABLE %s ALTER CONSTRAINT %I DEFERRABLE INITIALLY IMMEDIATE',
                       fk.child_table, fk.conname);
        n := n + 1;
      END LOOP;
    END $$;
  `);
}
