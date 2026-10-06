import { foreignKey, index, integer, jsonb, pgEnum, pgTable, smallint, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations } from './orgs';
import { users } from './users';
import { devices } from './devices';

/**
 * Administrator-approved, READ-ONLY diagnostic file access on one device
 * (migration 2026-12-13-130000-diagnostic-access-grants.sql).
 *
 * pending_approval -> active | denied | expired; active -> revoked | expired.
 * Requests are created by the `request_diagnostic_access` tool and decided
 * through approval_requests (diagnostic_access_grant_id link). A grant only
 * ever authorizes its beneficiary: the exact user session, API key or OAuth
 * grant that requested it. Holds scope and provenance only — never file contents.
 */
export const diagnosticAccessGrantStatusEnum = pgEnum('diagnostic_access_grant_status', [
  'pending_approval',
  'active',
  'denied',
  'revoked',
  'expired',
]);

export type DiagnosticAccessScope = { path: string; recursive: boolean };

export const diagnosticAccessGrants = pgTable(
  'diagnostic_access_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id),
    deviceId: uuid('device_id').notNull().references(() => devices.id),
    status: diagnosticAccessGrantStatusEnum('status').notNull().default('pending_approval'),
    requestedByUserId: uuid('requested_by_user_id').notNull().references(() => users.id),
    beneficiaryKind: varchar('beneficiary_kind', { length: 16 }).$type<'user' | 'api_key' | 'oauth_grant'>().notNull(),
    beneficiaryId: uuid('beneficiary_id').notNull(),
    source: varchar('source', { length: 32 }).notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    requestExpiresAt: timestamp('request_expires_at', { withTimezone: true }).notNull(),
    purpose: text('purpose').notNull(),
    operations: text('operations').array().notNull(),
    scopes: jsonb('scopes').$type<DiagnosticAccessScope[]>().notNull(),
    sensitiveClasses: text('sensitive_classes').array().notNull().default(sql`'{}'::text[]`),
    durationMinutes: integer('duration_minutes').notNull(),
    approvedByUserId: uuid('approved_by_user_id').references(() => users.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    deniedByUserId: uuid('denied_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    deniedAt: timestamp('denied_at', { withTimezone: true }),
    denialReason: text('denial_reason'),
    decidedAssuranceLevel: smallint('decided_assurance_level'),
    decidedVia: varchar('decided_via', { length: 32 }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedByUserId: uuid('revoked_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    revokeReason: text('revoke_reason'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    useCount: integer('use_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    deviceActiveIdx: index('idx_diagnostic_access_grants_device_active')
      .on(table.deviceId, table.expiresAt)
      .where(sql`status = 'active'`),
    beneficiaryIdx: index('idx_diagnostic_access_grants_beneficiary')
      .on(table.deviceId, table.beneficiaryKind, table.beneficiaryId)
      .where(sql`status IN ('pending_approval', 'active')`),
    orgIdx: index('idx_diagnostic_access_grants_org').on(table.orgId, table.createdAt.desc()),
    // DEFERRABLE INITIALLY DEFERRED in the migration (the device-move restamp
    // updates devices before this row); Drizzle does not model deferrability.
    deviceOrgFk: foreignKey({
      columns: [table.deviceId, table.orgId],
      foreignColumns: [devices.id, devices.orgId],
      name: 'diagnostic_access_grants_device_org_fk',
    }),
  }),
);
