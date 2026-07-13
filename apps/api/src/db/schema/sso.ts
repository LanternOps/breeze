import { sql } from 'drizzle-orm';
import { bigint, boolean, check, foreignKey, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { organizations, partners } from './orgs';
import { users } from './users';
import { authBrowserTransitions } from './authBrowserTransitions';

export const ssoProviderTypeEnum = pgEnum('sso_provider_type', ['oidc', 'saml']);
export const ssoProviderStatusEnum = pgEnum('sso_provider_status', ['active', 'inactive', 'testing']);

// SSO Provider Configuration — dual ownership (#2183): org-axis (orgId set,
// partnerId NULL — customer-org SSO) XOR partner-axis (partnerId set, orgId
// NULL — the MSP's own technician login). Enforced by sso_providers_one_owner_chk.
export const ssoProviders = pgTable('sso_providers', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id),
  partnerId: uuid('partner_id').references(() => partners.id),

  // Provider identification
  name: varchar('name', { length: 255 }).notNull(),
  type: ssoProviderTypeEnum('type').notNull(),
  status: ssoProviderStatusEnum('status').notNull().default('inactive'),

  // OIDC Configuration
  issuer: varchar('issuer', { length: 500 }),
  clientId: varchar('client_id', { length: 255 }),
  clientSecret: text('client_secret'), // encrypted
  authorizationUrl: varchar('authorization_url', { length: 500 }),
  tokenUrl: varchar('token_url', { length: 500 }),
  userInfoUrl: varchar('userinfo_url', { length: 500 }),
  jwksUrl: varchar('jwks_url', { length: 500 }),
  scopes: varchar('scopes', { length: 500 }).default('openid profile email'),

  // SAML Configuration (future)
  entityId: varchar('entity_id', { length: 500 }),
  ssoUrl: varchar('sso_url', { length: 500 }),
  certificate: text('certificate'),

  // Attribute mapping
  attributeMapping: jsonb('attribute_mapping').$type<{
    email: string;
    name: string;
    firstName?: string;
    lastName?: string;
    groups?: string;
  }>().default({
    email: 'email',
    name: 'name'
  }),

  // Behavior settings
  autoProvision: boolean('auto_provision').notNull().default(true),
  defaultRoleId: uuid('default_role_id'),
  allowedDomains: varchar('allowed_domains', { length: 1000 }), // comma-separated
  enforceSSO: boolean('enforce_sso').notNull().default(false), // disable password login
  // security review #2 (H-1): when true AND the verified id_token's `amr`
  // attests multi-factor, SSO logins mint mfa:true (so the org can satisfy
  // Breeze MFA-gated routes via their IdP). Off by default — fail-safe.
  trustsIdpMfa: boolean('trusts_idp_mfa').notNull().default(false),

  // Metadata
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});

// User SSO identity links. Unique (provider_id, external_id): one IdP subject
// maps to at most one Breeze user — enforced at the DB layer (#2195) so the
// callback's code-only identity-in-use check can't be raced (TOCTOU).
export const userSsoIdentities = pgTable('user_sso_identities', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  providerId: uuid('provider_id').notNull().references(() => ssoProviders.id),

  // External identity
  externalId: varchar('external_id', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }).notNull(),

  // Profile data from provider
  profile: jsonb('profile'),

  // Tokens (encrypted)
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  tokenExpiresAt: timestamp('token_expires_at'),

  lastLoginAt: timestamp('last_login_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (t) => ({
  providerExternalUnique: uniqueIndex('user_sso_identities_provider_external_idx').on(t.providerId, t.externalId),
}));

// SSO Login sessions (for CSRF protection)
export const ssoSessions = pgTable(
  'sso_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    providerId: uuid('provider_id').notNull().references(() => ssoProviders.id),

    state: varchar('state', { length: 64 }).notNull().unique(),
    nonce: varchar('nonce', { length: 64 }).notNull(),
    codeVerifier: varchar('code_verifier', { length: 128 }), // for PKCE
    redirectUrl: varchar('redirect_url', { length: 500 }),

  // Link-mode marker (#2183 Connect SSO): when set, the callback links the
  // verified identity to this user instead of minting login tokens.
  // ON DELETE CASCADE: an abandoned link session (never completed, so never
  // deleted by the callback) must not block a hard user delete — sso_sessions
  // has no partner_id/org_id, so the tenant-cascade sweep never reaches it.
    linkUserId: uuid('link_user_id').references(() => users.id, { onDelete: 'cascade' }),

    // Nullable for pre-rollout SSO sessions. New login starts capture both
    // values so the callback can recover the exact browser generation without
    // depending on a SameSite cookie.
    browserTransitionId: uuid('browser_transition_id'),
    browserGeneration: bigint('browser_generation', { mode: 'number' }),

    expiresAt: timestamp('expires_at').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    browserTransitionPairCheck: check(
      'sso_sessions_browser_transition_pair_chk',
      sql`(${table.browserTransitionId} IS NULL) = (${table.browserGeneration} IS NULL)`,
    ),
    browserGenerationCheck: check(
      'sso_sessions_browser_generation_chk',
      sql`${table.browserGeneration} IS NULL OR ${table.browserGeneration} >= 1`,
    ),
    browserTransitionFk: foreignKey({
      columns: [table.browserTransitionId],
      foreignColumns: [authBrowserTransitions.id],
      name: 'sso_sessions_browser_transition_fk',
    }),
  }),
);

// SSO Verified Domains — org proves DNS ownership before JIT-provisioning is
// allowed for addresses in the domain (security review #2, H-2, Plan B).
// RLS shape 1: direct org_id, breeze_has_org_access(org_id).
export const ssoVerifiedDomains = pgTable('sso_verified_domains', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  domain: varchar('domain', { length: 253 }).notNull(),
  verificationToken: varchar('verification_token', { length: 128 }).notNull(),
  verifiedAt: timestamp('verified_at'),
  lastCheckedAt: timestamp('last_checked_at'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  orgDomainUnique: uniqueIndex('sso_verified_domains_org_domain_idx').on(t.orgId, t.domain),
}));
