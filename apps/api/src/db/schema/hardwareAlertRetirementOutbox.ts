/**
 * W03 Task 12 — durable retirement recovery outbox.
 *
 * `resolveAlertsForRemovedComponents` (`services/hardwareHealth/retire.ts`)
 * runs inside the ingest/reaper savepoint that also deletes the retired
 * `device_hardware_components` row, and often precedes a device-delete
 * cascade that removes the alert itself. Neither the alert nor the device
 * can be trusted to survive until the recovery event is published, so the
 * envelope is copied into this org-scoped table (no device_id/alert_id FK)
 * before either can be deleted. See `retirementOutbox.ts`.
 */
import { index, jsonb, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './orgs';

export const hardwareAlertRetirementOutbox = pgTable('hardware_alert_retirement_outbox', {
  id: uuid('id').primaryKey(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  envelope: jsonb('envelope').notNull(),
  leaseToken: uuid('lease_token'),
  leaseUntil: timestamp('lease_until', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('hardware_alert_retirement_outbox_org_idx').on(table.orgId)]);
