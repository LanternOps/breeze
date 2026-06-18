import {
  sql,
} from 'drizzle-orm';
import {
  index,
  jsonb,
  pgTable,
  real,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { users } from './users';
import type {
  MlFeedbackEventOutcome,
  MlFeedbackEventSourceType,
  MlFeedbackEventType,
} from '@breeze/shared';

export const mlFeedbackEvents = pgTable('ml_feedback_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  sourceType: varchar('source_type', { length: 40 }).$type<MlFeedbackEventSourceType>().notNull(),
  sourceId: varchar('source_id', { length: 255 }).notNull(),
  eventType: varchar('event_type', { length: 80 }).$type<MlFeedbackEventType>().notNull(),
  dedupeKey: varchar('dedupe_key', { length: 255 }),
  actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
  outcome: varchar('outcome', { length: 60 }).$type<MlFeedbackEventOutcome>().notNull(),
  confidence: real('confidence'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  occurredAt: timestamp('occurred_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  dedupeIdx: uniqueIndex('ml_feedback_events_dedupe_uq').on(
    table.sourceType,
    table.sourceId,
    table.eventType,
    table.occurredAt,
  ),
  semanticDedupeIdx: uniqueIndex('ml_feedback_events_semantic_dedupe_uq')
    .on(table.orgId, table.sourceType, table.sourceId, table.eventType, table.dedupeKey)
    .where(sql`${table.dedupeKey} IS NOT NULL`),
  orgOccurredIdx: index('ml_feedback_events_org_occurred_idx').on(table.orgId, table.occurredAt),
  orgEventIdx: index('ml_feedback_events_org_event_idx').on(table.orgId, table.eventType, table.occurredAt),
  sourceIdx: index('ml_feedback_events_source_idx').on(table.sourceType, table.sourceId, table.occurredAt),
}));
