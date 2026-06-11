import { pgTable, uuid, text, varchar, timestamp, jsonb, pgEnum, index, foreignKey, boolean } from 'drizzle-orm/pg-core';
import { users } from './users';
import { oauthClients, oauthSessions } from './oauth';
import { aiToolExecutions } from './ai';

export const approvalRiskTierEnum = pgEnum('approval_risk_tier', [
  'low',
  'medium',
  'high',
  'critical',
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
     * Server-issued: TRUE when the requesting OAuth client is the user's
     * own mobile app AND the request targets that same user (i.e. the phone
     * is approving its own action). Replaces the mobile client's
     * label-prefix heuristic; gates the 5s hold-to-confirm self-approval UX.
     * Defaults to FALSE; populated via deriveIsRecursive() at insert time.
     */
    isRecursive: boolean('is_recursive').notNull().default(false),

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
  })
);

export type ApprovalRequest = typeof approvalRequests.$inferSelect;
export type NewApprovalRequest = typeof approvalRequests.$inferInsert;
