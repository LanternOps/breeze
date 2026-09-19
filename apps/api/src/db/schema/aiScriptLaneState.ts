import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { users } from './users';

export type AiScriptLaneStateValue = 'closed' | 'open';

/**
 * AI script authoring W04 (#5612). Per-ORG circuit for the unattended script
 * lane. Deliberately NOT a reuse of ai_agent_circuit_state, which is keyed
 * (org_id, agent_id): a chat session has no agent key (spec §4.1). Agents
 * remain subject to their own circuit as well — this one is additional,
 * never a replacement. Opens after 2 consecutive failed/unknown verifications.
 */
export const aiScriptLaneState = pgTable('ai_script_lane_state', {
  orgId: uuid('org_id')
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  consecutiveFailedVerifications: integer('consecutive_failed_verifications').notNull().default(0),
  state: text('state').$type<AiScriptLaneStateValue>().notNull().default('closed'),
  openedAt: timestamp('opened_at', { withTimezone: true }),
  openedReason: text('opened_reason'),
  resetByUserId: uuid('reset_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  resetAt: timestamp('reset_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type AiScriptLaneStateRow = typeof aiScriptLaneState.$inferSelect;
export type NewAiScriptLaneStateRow = typeof aiScriptLaneState.$inferInsert;
