import { pgTable, uuid, text, varchar, timestamp, jsonb, pgEnum, index } from 'drizzle-orm/pg-core';
import { users } from './users';
import { oauthClients, oauthSessions } from './oauth';

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

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userPendingIdx: index('approval_requests_user_pending_idx').on(t.userId, t.status, t.expiresAt),
    createdAtIdx: index('approval_requests_created_at_idx').on(t.createdAt),
  })
);

export type ApprovalRequest = typeof approvalRequests.$inferSelect;
export type NewApprovalRequest = typeof approvalRequests.$inferInsert;
