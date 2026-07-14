import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
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
    tenantId: varchar('tenant_id', { length: 36 }).notNull(),
    clientId: varchar('client_id', { length: 64 }).notNull(),
    clientSecret: text('client_secret'),
    profile: varchar('profile', { length: 64 }).$type<StoredM365ConnectionProfile>().notNull(),
    authMode: varchar('auth_mode', { length: 40 }).$type<StoredM365AuthMode>().notNull(),
    credentialDomain: varchar('credential_domain', { length: 64 }).$type<StoredM365CredentialDomain>().notNull(),
    vaultRef: text('vault_ref'),
    credentialVersion: varchar('credential_version', { length: 128 }),
    permissionManifestVersion: integer('permission_manifest_version').notNull(),
    observedGrants: jsonb('observed_grants').$type<string[]>().notNull().default([]),
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
  }),
);

export type M365ConnectionRow = typeof m365Connections.$inferSelect;
export type NewM365ConnectionRow = typeof m365Connections.$inferInsert;
