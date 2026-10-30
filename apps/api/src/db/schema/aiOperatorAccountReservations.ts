import { sql } from 'drizzle-orm';
import { foreignKey, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { users } from './users';
import { aiOperatorTasks } from './aiOperatorTasks';
import type { AiOperatorAccountProvider } from './aiOperatorTaskGraph';

// AI Operator per-provider-account reservations (#9981).
// Migration: apps/api/migrations/2027-01-17-170000-ai-operator-account-reservations.sql
// — read its header for the lifecycle; this file mirrors it.
//
// Tenancy Shape 1: direct, NOT NULL `org_id`, ENABLE + FORCE RLS with
// `breeze_has_org_access(org_id)` policies in the creating migration.
// The release-on-terminal trigger on ai_operator_tasks
// (`ai_operator_tasks_release_account_reservations`) cannot be modelled here.

export const AI_OPERATOR_RESERVATION_RELEASE_REASONS = [
  /** The task reached a terminal state with nothing that may still land. */
  'task_settled',
  /** An `unknown_effect` task's last in-flight operation settled (reconciler). */
  'effects_settled',
  /** A person confirmed the provider and released it through the API. */
  'released_by_user',
  /** The task re-froze a different account for the same provider. */
  'superseded',
] as const;
export type AiOperatorReservationReleaseReason = (typeof AI_OPERATOR_RESERVATION_RELEASE_REASONS)[number];

export const aiOperatorAccountReservations = pgTable(
  'ai_operator_account_reservations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id),
    taskId: uuid('task_id').notNull(),
    provider: text('provider').$type<AiOperatorAccountProvider>().notNull(),
    /** Immutable Entra object id / Google user id — never the UPN. */
    externalId: text('external_id').notNull(),
    /** Display only, frozen at reservation. */
    principalLabel: text('principal_label').notNull(),
    reservedAt: timestamp('reserved_at', { withTimezone: true }).defaultNow().notNull(),
    /** NULL = active. */
    releasedAt: timestamp('released_at', { withTimezone: true }),
    releaseReason: text('release_reason').$type<AiOperatorReservationReleaseReason>(),
    releasedByUserId: uuid('released_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    releaseNote: text('release_note'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    // THE guarantee: one active reservation per account per org.
    activeUq: uniqueIndex('ai_operator_account_reservations_active_uq')
      .on(table.orgId, table.provider, table.externalId)
      .where(sql`released_at IS NULL`),
    taskIdx: index('ai_operator_account_reservations_task_idx').on(table.orgId, table.taskId),
    taskOrgFk: foreignKey({
      columns: [table.taskId, table.orgId],
      foreignColumns: [aiOperatorTasks.id, aiOperatorTasks.orgId],
      name: 'ai_operator_account_reservations_task_org_fk',
    }).onDelete('cascade'),
  }),
);
