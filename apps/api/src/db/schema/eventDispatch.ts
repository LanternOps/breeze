import { pgTable, varchar, uuid, integer, text, timestamp, index, primaryKey } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations } from './orgs';

// Wave 3.5c (#4085): durable per-subscriber delivery receipts, keyed
// (event_id, subscriber_id). Tenancy shape 1 (direct org_id). Written ONLY
// under system DB context by the event-dispatch worker; org policies exist
// for the RLS contract + GDPR erasure. status: planned -> delivering ->
// delivered | failed. 'delivering' found on a retry means a crash mid-handler:
// outcome unknown, re-claimed (at-least-once). No payload column, no jsonb —
// export-policy `excludedOpen` avoidance is by construction.
export const eventDeliveryReceipts = pgTable('event_delivery_receipts', {
  eventId: varchar('event_id', { length: 100 }).notNull(),
  subscriberId: varchar('subscriber_id', { length: 50 }).notNull(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  eventType: varchar('event_type', { length: 100 }).notNull(),
  mode: varchar('mode', { length: 10 }).notNull(), // 'shadow' | 'enforce'
  status: varchar('status', { length: 12 }).notNull().default('planned'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'), // truncated to 500 chars by the writer (Task 6)
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  deliveredAt: timestamp('delivered_at'),
}, (t) => [
  primaryKey({ columns: [t.eventId, t.subscriberId] }),
  index('event_delivery_receipts_org_idx').on(t.orgId),
  // Retention scans delete by age + terminal status; partial keeps it cheap.
  index('event_delivery_receipts_retention_idx')
    .on(t.createdAt)
    .where(sql`status IN ('delivered','failed')`),
  // Shadow comparison + drift metrics scan recent rows by mode.
  index('event_delivery_receipts_mode_created_idx').on(t.mode, t.createdAt),
]);
