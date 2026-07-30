import { sql } from 'drizzle-orm';
import {
  char,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import type { CanonicalAppRoleAssignment } from '@breeze/shared/m365';
import { organizations } from './orgs';
import { users } from './users';
import type {
  M365AuthMode,
  M365ConnectionProfile,
  M365CredentialDomain,
} from '../../services/m365ControlPlane/profiles';

export type StoredM365ConnectionProfile = M365ConnectionProfile | 'legacy-direct';
export type StoredM365AuthMode = M365AuthMode | 'client-secret-legacy';
export type StoredM365CredentialDomain = M365CredentialDomain | 'legacy-direct';
export type M365ConnectionStatus =
  | 'pending-consent'
  | 'verifying'
  | 'active'
  | 'degraded'
  | 'suspended'
  | 'revoked';

export const m365Connections = pgTable(
  'm365_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    tenantId: varchar('tenant_id', { length: 36 }),
    clientId: varchar('client_id', { length: 64 }).notNull(),
    clientSecret: text('client_secret'),
    profile: varchar('profile', { length: 64 }).$type<StoredM365ConnectionProfile>().notNull(),
    authMode: varchar('auth_mode', { length: 40 }).$type<StoredM365AuthMode>().notNull(),
    credentialDomain: varchar('credential_domain', { length: 64 }).$type<StoredM365CredentialDomain>().notNull(),
    vaultRef: text('vault_ref'),
    credentialVersion: varchar('credential_version', { length: 128 }),
    permissionManifestVersion: integer('permission_manifest_version').notNull().default(0),
    observedGrants: jsonb('observed_grants').$type<CanonicalAppRoleAssignment[]>().notNull().default([]),
    consentAttemptId: uuid('consent_attempt_id'),
    // Delegated (user-axis) identity, pinned from the validated ID token at consent.
    // §5.2's release-time binding check compares against these: connection id alone is
    // insufficient because reconnect reuses the same row.
    delegatedUserObjectId: uuid('delegated_user_object_id'),
    // Bumped by every consent promotion — what actually detects a mailbox reconnected
    // (possibly as a different person) between approval and release.
    consentGeneration: integer('consent_generation').notNull().default(0),
    // Scopes Microsoft actually granted, from MSAL's AuthenticationResult.scopes. The
    // delegated counterpart of observedGrants; never sourced by parsing an access token.
    observedDelegatedScopes: jsonb('observed_delegated_scopes').$type<string[]>().notNull().default([]),
    grantsVerifiedAt: timestamp('grants_verified_at', { withTimezone: true }),
    displayName: varchar('display_name', { length: 256 }),
    status: varchar('status', { length: 32 }).$type<M365ConnectionStatus>().notNull().default('pending-consent'),
    consentedAt: timestamp('consented_at', { withTimezone: true }),
    lastVerifiedAt: timestamp('last_verified_at'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastErrorCode: varchar('last_error_code', { length: 80 }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    orgProfileUniq: uniqueIndex('m365_connections_org_profile_uniq').on(t.orgId, t.profile),
    userProfileUniq: uniqueIndex('m365_connections_user_profile_uniq').on(t.userId, t.profile),
    verifiedTenantProfileUniq: uniqueIndex('m365_connections_verified_tenant_profile_uniq')
      .on(t.tenantId, t.profile)
      .where(sql`${t.tenantId} IS NOT NULL
        AND ${t.orgId} IS NOT NULL
        AND ${t.userId} IS NULL
        AND ${t.profile} IN (
          'customer-graph-read',
          'customer-graph-actions',
          'customer-exchange-powershell'
        )`),
    attemptIdentityUniq: uniqueIndex('m365_connections_id_org_profile_attempt_uniq')
      .on(t.id, t.orgId, t.profile, t.consentAttemptId),
    // User-axis counterpart. A delegated row has org_id NULL, and under MATCH SIMPLE a
    // composite FK with any NULL column is not enforced at all — so the user-axis consent
    // session needs its own target index rather than reusing the org-axis one.
    userAttemptIdentityUniq: uniqueIndex('m365_connections_id_user_profile_attempt_uniq')
      .on(t.id, t.userId, t.profile, t.consentAttemptId),
  }),
);

export type M365ConnectionRow = typeof m365Connections.$inferSelect;
export type NewM365ConnectionRow = typeof m365Connections.$inferInsert;

export type M365ConsentPhase = 'admin_consent' | 'identity_verification';

export const m365ConsentSessions = pgTable(
  'm365_consent_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    stateHash: char('state_hash', { length: 64 }).notNull(),
    phase: varchar('phase', { length: 24 }).$type<M365ConsentPhase>().notNull(),
    connectionId: uuid('connection_id').notNull(),
    orgId: uuid('org_id').notNull(),
    profile: varchar('profile', { length: 64 })
      .$type<'customer-graph-read' | 'customer-graph-actions'>()
      .notNull(),
    consentAttemptId: uuid('consent_attempt_id').notNull(),
    userId: uuid('user_id').notNull(),
    tenantHintHash: char('tenant_hint_hash', { length: 64 }),
    nonce: text('nonce'),
    codeVerifier: text('code_verifier'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    stateHashUniq: uniqueIndex('m365_consent_sessions_state_hash_uniq').on(t.stateHash),
    expiresAtIdx: index('m365_consent_sessions_expires_at_idx').on(t.expiresAt),
    connectionAttemptIdx: index('m365_consent_sessions_connection_attempt_idx')
      .on(t.connectionId, t.consentAttemptId),
    connectionIdentityFk: foreignKey({
      columns: [t.connectionId, t.orgId, t.profile, t.consentAttemptId],
      foreignColumns: [
        m365Connections.id,
        m365Connections.orgId,
        m365Connections.profile,
        m365Connections.consentAttemptId,
      ],
      name: 'm365_consent_sessions_connection_identity_fkey',
    }).onDelete('cascade'),
    orgFk: foreignKey({
      columns: [t.orgId],
      foreignColumns: [organizations.id],
      name: 'm365_consent_sessions_org_id_fkey',
    }).onDelete('cascade'),
    userFk: foreignKey({
      columns: [t.userId],
      foreignColumns: [users.id],
      name: 'm365_consent_sessions_user_id_fkey',
    }).onDelete('cascade'),
    profileCheck: check(
      'm365_consent_sessions_profile_check',
      sql`${t.profile} IN ('customer-graph-read', 'customer-graph-actions')`,
    ),
    phaseCheck: check(
      'm365_consent_sessions_phase_check',
      sql`${t.phase} IN ('admin_consent', 'identity_verification')`,
    ),
    phaseFieldsCheck: check(
      'm365_consent_sessions_phase_fields_check',
      sql`(
        ${t.phase} = 'admin_consent'
        AND ${t.tenantHintHash} IS NULL
        AND ${t.nonce} IS NULL
        AND ${t.codeVerifier} IS NULL
      ) OR (
        ${t.phase} = 'identity_verification'
        AND ${t.tenantHintHash} IS NOT NULL
        AND ${t.nonce} IS NOT NULL
        AND ${t.codeVerifier} IS NOT NULL
      )`,
    ),
  }),
);

export type M365ConsentSessionRow = typeof m365ConsentSessions.$inferSelect;
export type NewM365ConsentSessionRow = typeof m365ConsentSessions.$inferInsert;

/**
 * Delegated (user-axis) consent sessions — design §4.2.
 *
 * A separate table from `m365ConsentSessions` rather than a nullable `orgId` on it: that
 * table has `org_id NOT NULL` and a composite FK into the org-axis unique index, so it
 * structurally cannot hold a user-owned row.
 *
 * Note the absence of `tenantHintHash`, which is the substantive difference rather than an
 * omission. The shipped `identity_verification` phase requires a tenant GUID *before*
 * authorization, because an admin consented for a known customer tenant. A user's first
 * delegated sign-in happens at `/common` and Breeze learns `tid` only from the ID token
 * that comes back — there is nothing to hash beforehand.
 */
export type M365DelegatedConsentPhase = 'delegated_consent';

export const m365UserConsentSessions = pgTable(
  'm365_user_consent_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    stateHash: char('state_hash', { length: 64 }).notNull(),
    phase: varchar('phase', { length: 24 }).$type<M365DelegatedConsentPhase>().notNull(),
    connectionId: uuid('connection_id').notNull(),
    userId: uuid('user_id').notNull(),
    profile: varchar('profile', { length: 64 }).$type<'communications-delegated'>().notNull(),
    consentAttemptId: uuid('consent_attempt_id').notNull(),
    // NOT NULL, unlike the org-axis table where they are phase-dependent: every delegated
    // consent is an auth-code + PKCE flow, so both always exist.
    nonce: text('nonce').notNull(),
    codeVerifier: text('code_verifier').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    stateHashUniq: uniqueIndex('m365_user_consent_sessions_state_hash_uniq').on(t.stateHash),
    expiresAtIdx: index('m365_user_consent_sessions_expires_at_idx').on(t.expiresAt),
    connectionAttemptIdx: index('m365_user_consent_sessions_connection_attempt_idx')
      .on(t.connectionId, t.consentAttemptId),
    // All four columns NOT NULL is load-bearing: under MATCH SIMPLE a composite FK with any
    // NULL column is not enforced at all.
    //
    // ON DELETE CASCADE does NOT cover UPDATE, and there is no ON UPDATE CASCADE (matching
    // the org-axis FK). Rotating consentAttemptId on the parent raises an FK violation
    // rather than cascading, so the consent flow must delete this attempt's sessions first,
    // in the same locked transaction — see deleteConsentSessionsForAttemptInTransaction.
    connectionIdentityFk: foreignKey({
      columns: [t.connectionId, t.userId, t.profile, t.consentAttemptId],
      foreignColumns: [
        m365Connections.id,
        m365Connections.userId,
        m365Connections.profile,
        m365Connections.consentAttemptId,
      ],
      name: 'm365_user_consent_sessions_connection_identity_fkey',
    }).onDelete('cascade'),
    userFk: foreignKey({
      columns: [t.userId],
      foreignColumns: [users.id],
      name: 'm365_user_consent_sessions_user_id_fkey',
    }).onDelete('cascade'),
    profileCheck: check(
      'm365_user_consent_sessions_profile_check',
      sql`${t.profile} = 'communications-delegated'`,
    ),
    phaseCheck: check(
      'm365_user_consent_sessions_phase_check',
      sql`${t.phase} = 'delegated_consent'`,
    ),
  }),
);

export type M365UserConsentSessionRow = typeof m365UserConsentSessions.$inferSelect;
export type NewM365UserConsentSessionRow = typeof m365UserConsentSessions.$inferInsert;
