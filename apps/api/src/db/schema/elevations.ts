import {
  foreignKey,
  index,
  inet,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { organizations, partners, sites } from './orgs';
import { users } from './users';
import { devices } from './devices';
import { approvalRequests, approvalFactorEnum } from './approvals';
import { softwarePolicies } from './softwarePolicies';
import { aiToolExecutions } from './ai';
import type { AssuranceLevel } from '@breeze/shared';

// PAM Track 1: privileged access management.
//
// Three flows on one table, distinguished by `flow_type`:
//   * uac_intercept  — end-user UAC prompt captured by the agent, requests
//                      temporary admin via Breeze policy.
//   * tech_jit_admin — technician-initiated just-in-time admin grant against
//                      a device they're managing.
//   * ai_tool_action — a governed (tier>=2) Breeze Helper AI tool invocation
//                      (Phase 1 of security finding A, spec 2026-06-10);
//                      links back to ai_tool_executions via execution_id.
//
// Tenancy Shape 1: direct `org_id` column. site_id / partner_id are
// denormalized for ops queries (mirrors devices.ts). RLS policies key on
// breeze_has_org_access(org_id).

export const elevationFlowTypeEnum = pgEnum('elevation_flow_type', [
  'uac_intercept',
  'tech_jit_admin',
  'ai_tool_action',
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
  // 'actuating' = Track 5 single-use guard. Atomic CAS from 'approved' by
  // the actuator route; row stays here until the agent reports completion
  // (Track 6 — JIT credential expiry / cleanup), at which point it flips to
  // 'expired' or 'revoked'.
  'actuating',
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
    revision: integer('revision').notNull().default(1),

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

    // ai_tool_action flow (Phase 1, spec 2026-06-10): links the PAM decision
    // back to the AI tool gate. ON DELETE SET NULL — historical elevations
    // outlive their execution rows; flow_shape_chk requires tool_name only.
    executionId: uuid('execution_id').references(() => aiToolExecutions.id, {
      onDelete: 'set null',
    }),
    toolName: varchar('tool_name', { length: 100 }),
    actionDigest: varchar('action_digest', { length: 64 }),
    riskTier: smallint('risk_tier'),

    // Level satisfied by the decision (1..4); DB-capped by
    // elevation_requests_decided_level_range_chk. `.$type` aligns the inferred
    // read type with that invariant (issue #1372).
    decidedAssuranceLevel: smallint('decided_assurance_level').$type<AssuranceLevel>(),
    decidedVia: approvalFactorEnum('decided_via'),
    authenticatorDeviceId: uuid('authenticator_device_id'),

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

export const pamDesiredStateEnum = ['active', 'cleanup'] as const;
export type PamDesiredState = (typeof pamDesiredStateEnum)[number];

export const pamObservedStateEnum = [
  'pending_dispatch', 'dispatched', 'received', 'verified_active',
  'cleanup_pending', 'cleaned', 'failed', 'legacy_untracked',
] as const;
export type PamObservedState = (typeof pamObservedStateEnum)[number];

export const pamResultKindEnum = ['received', 'verified_active', 'cleaned', 'failed'] as const;
export type PamResultKind = (typeof pamResultKindEnum)[number];

export const pamActuations = pgTable(
  'pam_actuations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id').notNull(),
    elevationRequestId: uuid('elevation_request_id').notNull(),
    requestRevision: integer('request_revision').notNull(),
    generation: integer('generation').notNull(),
    desiredState: text('desired_state').notNull().$type<PamDesiredState>(),
    observedState: text('observed_state').notNull().$type<PamObservedState>(),
    currentCommandId: uuid('current_command_id'),
    targetExecutablePath: text('target_executable_path').notNull(),
    targetExecutableHash: varchar('target_executable_hash', { length: 64 }),
    subjectUsername: varchar('subject_username', { length: 255 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    cleanupRequestedAt: timestamp('cleanup_requested_at', { withTimezone: true }),
    cleanedAt: timestamp('cleaned_at', { withTimezone: true }),
    failureCode: varchar('failure_code', { length: 128 }),
    latestEvidence: jsonb('latest_evidence').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    requestRevisionUq: unique('pam_actuations_request_revision_key').on(
      table.elevationRequestId,
      table.requestRevision,
    ),
    idOrgUq: unique('pam_actuations_id_org_id_key').on(table.id, table.orgId),
    deviceOrgFk: foreignKey({
      columns: [table.deviceId, table.orgId],
      foreignColumns: [devices.id, devices.orgId],
      name: 'pam_actuations_device_id_org_id_fkey',
    }).onDelete('cascade'),
    requestOrgFk: foreignKey({
      columns: [table.elevationRequestId, table.orgId],
      foreignColumns: [elevationRequests.id, elevationRequests.orgId],
      name: 'pam_actuations_elevation_request_id_org_id_fkey',
    }).onDelete('cascade'),
    deviceGenerationIdx: index('pam_actuations_device_generation_idx').on(
      table.deviceId,
      table.generation,
    ),
  }),
);

export const pamActuationResults = pgTable(
  'pam_actuation_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    observationId: uuid('observation_id').notNull(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id').notNull(),
    actuationId: uuid('actuation_id').notNull(),
    generation: integer('generation').notNull(),
    resultKind: text('result_kind').notNull().$type<PamResultKind>(),
    failureCode: varchar('failure_code', { length: 128 }),
    evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull().default({}),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    observationUq: unique('pam_actuation_results_observation_key').on(
      table.actuationId,
      table.generation,
      table.resultKind,
      table.observationId,
    ),
    actuationOrgFk: foreignKey({
      columns: [table.actuationId, table.orgId],
      foreignColumns: [pamActuations.id, pamActuations.orgId],
      name: 'pam_actuation_results_actuation_id_org_id_fkey',
    }).onDelete('cascade'),
    deviceOrgFk: foreignKey({
      columns: [table.deviceId, table.orgId],
      foreignColumns: [devices.id, devices.orgId],
      name: 'pam_actuation_results_device_id_org_id_fkey',
    }).onDelete('cascade'),
    actuationGenerationIdx: index('pam_actuation_results_actuation_generation_idx').on(
      table.actuationId,
      table.generation,
    ),
  }),
);

export type ElevationRequest = typeof elevationRequests.$inferSelect;
export type NewElevationRequest = typeof elevationRequests.$inferInsert;
export type PamActuation = typeof pamActuations.$inferSelect;
export type NewPamActuation = typeof pamActuations.$inferInsert;
export type PamActuationResult = typeof pamActuationResults.$inferSelect;
export type NewPamActuationResult = typeof pamActuationResults.$inferInsert;

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
