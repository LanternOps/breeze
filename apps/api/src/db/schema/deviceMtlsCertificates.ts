import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { devices } from './devices';
import { organizations } from './orgs';

// Durable device mTLS certificate history (security remediation Wave 5,
// Task 1). One row per issued certificate — never overwritten in place, so
// the full lifecycle (issuance, activation, revocation, retry) survives
// rotation and audit. Later Wave 5 tasks (services/routes) build on this
// schema; this task ONLY lands the model + forced-RLS migration.
//
// Tenancy: Shape 1 (direct org_id), auto-discovered by the RLS coverage
// contract test — see rls-coverage.integration.test.ts's explicit
// "device_mtls_certificates is discovered as a direct-org table" assertion.
// The composite FK (device_id, org_id) -> devices(id, org_id) structurally
// pins every certificate row to the SAME org as its device — the same
// same-org invariant pattern as device_link_groups.
export type DeviceMtlsCertificateState =
  | 'pending_activation'
  | 'active'
  | 'pending_revocation'
  | 'revoked';

export const deviceMtlsCertificates = pgTable('device_mtls_certificates', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  deviceId: uuid('device_id').notNull(),
  providerCertificateId: varchar('provider_certificate_id', { length: 128 }).notNull(),
  serialNumber: varchar('serial_number', { length: 128 }).notNull(),
  fingerprintSha256: char('fingerprint_sha256', { length: 64 }),
  publicKeySpki: text('public_key_spki'),
  legacyProvenance: boolean('legacy_provenance').notNull().default(false),
  state: varchar('state', { length: 32 }).$type<DeviceMtlsCertificateState>().notNull(),
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  activationExpiresAt: timestamp('activation_expires_at', { withTimezone: true }),
  activatedAt: timestamp('activated_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokeAttempts: integer('revoke_attempts').notNull().default(0),
  lastRevokeError: varchar('last_revoke_error', { length: 255 }),
  nextRevokeAttemptAt: timestamp('next_revoke_attempt_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  // ON UPDATE CASCADE lets POST /devices/:id/move-org flip devices.org_id
  // without violating this composite FK (Wave 5 Task 2). Note: the
  // migration also declares this constraint DEFERRABLE INITIALLY DEFERRED
  // — drizzle-orm's foreignKey() builder has no deferrable option, so that
  // detail lives in the migration only (this schema is for type-safe
  // queries; db:check-drift does not compare FK options against the DB).
  foreignKey({
    columns: [table.deviceId, table.orgId],
    foreignColumns: [devices.id, devices.orgId],
    name: 'device_mtls_certificates_device_org_fkey',
  }).onUpdate('cascade').onDelete('cascade'),
  uniqueIndex('device_mtls_certificates_provider_uq').on(table.providerCertificateId),
  uniqueIndex('device_mtls_certificates_org_serial_uq').on(table.orgId, table.serialNumber),
  uniqueIndex('device_mtls_certificates_one_active_uq')
    .on(table.deviceId)
    .where(sql`${table.state} = 'active'`),
  index('device_mtls_certificates_org_device_state_idx')
    .on(table.orgId, table.deviceId, table.state),
  index('device_mtls_certificates_retry_idx')
    .on(table.state, table.nextRevokeAttemptAt),
  check('device_mtls_certificates_state_chk',
    sql`${table.state} IN ('pending_activation','active','pending_revocation','revoked')`),
  check('device_mtls_certificates_pending_expiry_chk',
    sql`${table.state} <> 'pending_activation' OR ${table.activationExpiresAt} IS NOT NULL`),
  check('device_mtls_certificates_active_time_chk',
    sql`${table.state} <> 'active' OR ${table.activatedAt} IS NOT NULL`),
  check('device_mtls_certificates_revoked_time_chk',
    sql`${table.state} <> 'revoked' OR ${table.revokedAt} IS NOT NULL`),
  check('device_mtls_certificates_fingerprint_chk',
    sql`${table.legacyProvenance} OR ${table.fingerprintSha256} IS NOT NULL`),
]);

export type DeviceMtlsCertificate = typeof deviceMtlsCertificates.$inferSelect;
export type NewDeviceMtlsCertificate = typeof deviceMtlsCertificates.$inferInsert;
