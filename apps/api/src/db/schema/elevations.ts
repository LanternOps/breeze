import {
  foreignKey,
  index,
  inet,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { organizations, partners, sites } from './orgs';
import { users } from './users';
import { devices } from './devices';
import { approvalRequests } from './approvals';
import { softwarePolicies } from './softwarePolicies';

// PAM Track 1: privileged access management.
//
// Two flows on one table, distinguished by `flow_type`:
//   * uac_intercept  — end-user UAC prompt captured by the agent, requests
//                      temporary admin via Breeze policy.
//   * tech_jit_admin — technician-initiated just-in-time admin grant against
//                      a device they're managing.
//
// Tenancy Shape 1: direct `org_id` column. site_id / partner_id are
// denormalized for ops queries (mirrors devices.ts). RLS policies key on
// breeze_has_org_access(org_id).

export const elevationFlowTypeEnum = pgEnum('elevation_flow_type', [
  'uac_intercept',
  'tech_jit_admin',
]);

// Distinct from approval_status — adds auto_approved (allowlist hit, no
// human in the loop) and revoked (cancelled before expiry).
export const elevationStatusEnum = pgEnum('elevation_status', [
  'pending',
  'approved',
  'auto_approved',
  'denied',
  'expired',
  'revoked',
]);

export const elevationAuditEventTypeEnum = pgEnum('elevation_audit_event_type', [
  'requested',
  'auto_approved',
  'approved',
  'denied',
  'expired',
  'revoked',
  'session_started',
  'session_ended',
  'command_executed',
  'evidence_attached',
]);

export const elevationAuditActorEnum = pgEnum('elevation_audit_actor', [
  'end_user',
  'technician',
  'system',
  'policy',
]);

export const elevationRequests = pgTable(
  'elevation_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Tenancy (Shape 1)
    orgId: uuid('org_id').notNull().references(() => organizations.id),
    siteId: uuid('site_id').references(() => sites.id),
    partnerId: uuid('partner_id').references(() => partners.id),

    deviceId: uuid('device_id').notNull().references(() => devices.id),

    flowType: elevationFlowTypeEnum('flow_type').notNull(),

    // Subject: who the elevation is FOR.
    // uac_intercept may have a NULL subject_user_id (OS-account-only end users).
    // tech_jit_admin requires subject_user_id (enforced by DB CHECK).
    subjectUserId: uuid('subject_user_id').references(() => users.id, { onDelete: 'set null' }),
    subjectUsername: varchar('subject_username', { length: 255 }).notNull(),

    reason: text('reason').notNull(),

    // What's being elevated — uac_intercept only.
    targetExecutablePath: text('target_executable_path'),
    targetExecutableHash: varchar('target_executable_hash', { length: 64 }),
    targetExecutableSigner: varchar('target_executable_signer', { length: 255 }),
    targetPublisher: varchar('target_publisher', { length: 255 }),

    status: elevationStatusEnum('status').notNull().default('pending'),

    // Lifecycle (first-class timestamps per Todd).
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    expiredAt: timestamp('expired_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedByUserId: uuid('revoked_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    revokedReason: text('revoked_reason'),

    approvedByUserId: uuid('approved_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    deniedByUserId: uuid('denied_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    denialReason: text('denial_reason'),

    // Cross-references (per spec).
    parentApprovalId: uuid('parent_approval_id').references(
      () => approvalRequests.id,
      { onDelete: 'set null' },
    ),
    softwarePolicyMatchId: uuid('software_policy_match_id').references(
      () => softwarePolicies.id,
      { onDelete: 'set null' },
    ),

    // Session info, set by the agent once the grant is exercised.
    sessionStartedAt: timestamp('session_started_at', { withTimezone: true }),
    sessionEndedAt: timestamp('session_ended_at', { withTimezone: true }),
    clientIp: inet('client_ip'),
    userAgent: text('user_agent'),

    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    deviceIdIdx: index('elevation_requests_device_id_idx').on(table.deviceId),
    orgIdIdx: index('elevation_requests_org_id_idx').on(table.orgId),
    statusIdx: index('elevation_requests_status_idx').on(table.status),
    createdAtIdx: index('elevation_requests_created_at_idx').on(table.createdAt),
    // Composite-FK target: unique on (id, org_id) so elevation_audit can
    // reference it via FK. `id` is already PK so this adds no new tenancy
    // invariant — it just declares the tuple the composite FK references.
    // Mirrors organizations_id_partner_uq (2026-04-11-users-rls.sql §3).
    idOrgIdUq: unique('elevation_requests_id_org_id_key').on(table.id, table.orgId),
    // Note: the partial / WHERE-clause indexes
    //   elevation_requests_org_pending_idx,
    //   elevation_requests_expires_at_idx,
    //   elevation_requests_parent_approval_id_idx,
    //   elevation_requests_software_policy_match_id_idx
    // are declared in the SQL migration only; Drizzle's index DSL doesn't
    // model partial indexes cleanly. They show up in pg_indexes and are
    // covered by the migration; db:check-drift ignores partial-index WHERE
    // clauses (see the precedent in devices.ts hot indexes added by
    // 2026-05-17-a / 2026-05-19).
  }),
);

export type ElevationRequest = typeof elevationRequests.$inferSelect;
export type NewElevationRequest = typeof elevationRequests.$inferInsert;

export const elevationAudit = pgTable(
  'elevation_audit',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Denormalized org_id so the RLS policy is a direct Shape-1 check
    // (no JOIN through elevation_requests). Same pattern as
    // incident_evidence / incident_actions.
    orgId: uuid('org_id').notNull().references(() => organizations.id),

    // FK declared as a composite (elevation_request_id, org_id) →
    // elevation_requests(id, org_id) in the table-options block below.
    // No single-column .references() here — the composite FK is the only
    // DB-level tie, which guarantees the denormalized org_id matches the
    // parent's org_id (Shape-4 pattern, mirrors users_org_partner_fk).
    elevationRequestId: uuid('elevation_request_id').notNull(),

    eventType: elevationAuditEventTypeEnum('event_type').notNull(),
    actor: elevationAuditActorEnum('actor').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),

    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),

    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    requestOccurredIdx: index('elevation_audit_request_id_occurred_at_idx').on(
      table.elevationRequestId,
      table.occurredAt,
    ),
    orgIdIdx: index('elevation_audit_org_id_idx').on(table.orgId),
    eventTypeIdx: index('elevation_audit_event_type_idx').on(table.eventType),
    // Composite FK: (elevation_request_id, org_id) →
    // elevation_requests(id, org_id). Structural guarantee that the
    // denormalized org_id always matches the parent row's org_id.
    // ON DELETE CASCADE preserves the original single-column FK semantics.
    elevationRequestOrgFk: foreignKey({
      columns: [table.elevationRequestId, table.orgId],
      foreignColumns: [elevationRequests.id, elevationRequests.orgId],
      name: 'elevation_audit_elevation_request_id_org_id_fkey',
    }).onDelete('cascade'),
  }),
);

export type ElevationAuditEntry = typeof elevationAudit.$inferSelect;
export type NewElevationAuditEntry = typeof elevationAudit.$inferInsert;
