import { pgTable, uuid, text, varchar, timestamp, jsonb, pgEnum, index, foreignKey, boolean, smallint, char } from 'drizzle-orm/pg-core';
import type { AssuranceLevel } from '@breeze/shared';
import { users } from './users';
import { oauthClients, oauthSessions } from './oauth';
import { aiToolExecutions } from './ai';
import { actionIntents } from './actionIntents';

export const approvalRiskTierEnum = pgEnum('approval_risk_tier', [
  'low',
  'medium',
  'high',
  'critical',
]);

export const approvalFactorEnum = pgEnum('approval_factor', [
  'session_tap',
  'mobile_hw_key',
  'webauthn_platform',
]);

export const approvalStatusEnum = pgEnum('approval_status', [
  'pending',
  'approved',
  'denied',
  'expired',
  'reported',
]);

export const approvalRequests = pgTable(
  'approval_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    requestingClientId: text('requesting_client_id').references(() => oauthClients.id),
    requestingSessionId: text('requesting_session_id').references(() => oauthSessions.id),
    requestingClientLabel: varchar('requesting_client_label', { length: 255 }).notNull(),
    requestingMachineLabel: varchar('requesting_machine_label', { length: 255 }),
    actionLabel: text('action_label').notNull(),
    actionToolName: varchar('action_tool_name', { length: 255 }).notNull(),
    actionArguments: jsonb('action_arguments').notNull().default({}),
    riskTier: approvalRiskTierEnum('risk_tier').notNull(),
    riskSummary: text('risk_summary').notNull(),
    status: approvalStatusEnum('status').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionReason: text('decision_reason'),
    /**
     * For AI-agent-initiated approvals, links back to the
     * `ai_tool_executions` row that the SDK is blocked on via
     * `waitForApproval(executionId, ...)`. Nullable because non-AI
     * sources (helper, MCP step-up, dev seed) still create
     * approval_requests without an execution row. ON DELETE SET NULL —
     * orphaned approval rows remain readable for audit.
     */
    executionId: uuid('execution_id'),

    /**
     * #1254 PAM mobile bridge: links this fanned-out mobile approval back to
     * the `elevation_requests` row it was created for (a pending
     * uac_intercept). One elevation fans out to N approver rows that all carry
     * the same elevation_request_id; the first approver to decide mirrors the
     * decision onto the elevation (first-wins CAS) and the siblings are
     * expired. Nullable — non-PAM approvals (AI agent, helper, dev seed) never
     * set it. ON DELETE SET NULL so a purged elevation leaves the approval row
     * readable for audit (mirrors execution_id).
     */
    elevationRequestId: uuid('elevation_request_id'),

    /**
     * Action intents & durable approval layer (spec 2026-07-18): links this
     * fanned-out approval row back to the `action_intents` row it decides.
     * One intent fans out to N approver rows, all carrying the same
     * intent_id; the first approver to decide mirrors the decision onto the
     * intent (first-wins CAS). Nullable — non-intent approvals (PAM,
     * legacy AI agent, dev seed) never set it. ON DELETE CASCADE (unlike
     * execution_id/elevation_request_id's SET NULL) — intent-linked approval
     * rows have no independent audit meaning once their intent is gone.
     * Enforced mutually exclusive with execution_id/elevation_request_id by
     * approval_requests_one_source_chk.
     */
    intentId: uuid('intent_id').references(() => actionIntents.id, { onDelete: 'cascade' }),

    /**
     * What content this decision approved: SHA-256 hex digest bound at
     * fan-out time to the intent's argument_digest. Recorded on the decision
     * row itself (rather than re-read from the intent) so the approval
     * ledger is self-describing even if the intent's digest were ever
     * disputed. Nullable — only set for intent-linked rows.
     */
    boundArgumentDigest: char('bound_argument_digest', { length: 64 }),

    /**
     * Server-issued: TRUE when the requesting OAuth client is the user's
     * own mobile app AND the request targets that same user (i.e. the phone
     * is approving its own action). Replaces the mobile client's
     * label-prefix heuristic; gates the 5s hold-to-confirm self-approval UX.
     * Defaults to FALSE; populated via deriveIsRecursive() at insert time.
     */
    isRecursive: boolean('is_recursive').notNull().default(false),

    /**
     * Assurance level actually satisfied by the decision (1..4). The DB caps
     * the range via `approval_requests_decided_level_range_chk`; `.$type` keeps
     * the inferred read type aligned with that invariant (issue #1372).
     */
    decidedAssuranceLevel: smallint('decided_assurance_level').$type<AssuranceLevel>(),
    /** Factor actually used to decide: session_tap (L1), webauthn_platform or mobile_hw_key (L2+). */
    decidedVia: approvalFactorEnum('decided_via'),
    /** The authenticator device that signed the decision (null for session_tap). */
    authenticatorDeviceId: uuid('authenticator_device_id'),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userPendingIdx: index('approval_requests_user_pending_idx').on(t.userId, t.status, t.expiresAt),
    createdAtIdx: index('approval_requests_created_at_idx').on(t.createdAt),
    executionIdIdx: index('approval_requests_execution_id_idx').on(t.executionId),
    executionFk: foreignKey({
      columns: [t.executionId],
      foreignColumns: [aiToolExecutions.id],
      name: 'approval_requests_execution_id_fkey',
    }).onDelete('set null'),
    elevationRequestIdIdx: index('approval_requests_elevation_request_id_idx').on(
      t.elevationRequestId,
    ),
    intentIdIdx: index('approval_requests_intent_id_idx').on(t.intentId),
    // FK to elevation_requests(id) ON DELETE SET NULL is declared in the
    // migration only (2026-06-27-pam-approval-elevation-link.sql). Modeling it
    // in Drizzle would force an `import { elevationRequests } from
    // './elevations'`, but elevations.ts already imports approvalRequests
    // (parentApprovalId) — the cycle makes TS infer both tables as `any`
    // (TS7022). Same precedent as authenticatorDeviceId (DB FK, no Drizzle
    // reference). db:check-drift tolerates the column+index match.
  })
);

export type ApprovalRequest = typeof approvalRequests.$inferSelect;
export type NewApprovalRequest = typeof approvalRequests.$inferInsert;
