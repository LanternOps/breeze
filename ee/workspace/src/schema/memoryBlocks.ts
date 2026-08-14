import {
  pgTable, uuid, varchar, jsonb, timestamp, index, type AnyPgColumn,
} from 'drizzle-orm/pg-core';

/** Wick's exact shape — see internal/specs/2026-06-13 §5. Do not add an actor column. */
export const memoryBlocks = pgTable('memory_blocks', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  partnerId: uuid('partner_id'),
  blockType: varchar('block_type', { length: 64 }).notNull(),
  subjectKey: varchar('subject_key', { length: 280 }).notNull(),
  content: jsonb('content').notNull(),
  confidence: varchar('confidence', { length: 16 })
    .$type<'low' | 'medium' | 'high'>().notNull().default('medium'),
  authoredByRunId: uuid('authored_by_run_id'),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  retractedAt: timestamp('retracted_at', { withTimezone: true }),
  supersededById: uuid('superseded_by_id')
    .references((): AnyPgColumn => memoryBlocks.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('memory_blocks_org_subject_idx').on(t.orgId, t.subjectKey)]);
