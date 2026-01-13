import { pgTable, uuid, varchar, text, timestamp, boolean, jsonb, pgEnum } from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { users } from './users';

export const ssoProviderTypeEnum = pgEnum('sso_provider_type', ['oidc', 'saml']);
export const ssoProviderStatusEnum = pgEnum('sso_provider_status', ['active', 'inactive', 'testing']);

// SSO Provider Configuration per Organization
export const ssoProviders = pgTable('sso_providers', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),

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

  // Metadata
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});

// User SSO identity links
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
});

// SSO Login sessions (for CSRF protection)
export const ssoSessions = pgTable('sso_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  providerId: uuid('provider_id').notNull().references(() => ssoProviders.id),

  state: varchar('state', { length: 64 }).notNull().unique(),
  nonce: varchar('nonce', { length: 64 }).notNull(),
  codeVerifier: varchar('code_verifier', { length: 128 }), // for PKCE
  redirectUrl: varchar('redirect_url', { length: 500 }),

  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull()
});
