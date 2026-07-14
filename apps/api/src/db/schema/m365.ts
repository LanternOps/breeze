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
      .$type<'customer-graph-read'>()
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
      sql`${t.profile} = 'customer-graph-read'`,
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
