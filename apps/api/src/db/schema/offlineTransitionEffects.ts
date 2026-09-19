import { pgTable, text, uuid, timestamp, integer, jsonb, index } from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { devices } from './devices';
import type { OfflineEffectPayload } from '../../services/offlineEffectsTypes';

// Historical source ownership is immutable. Device/org deletion cancels pending
// work; a device move does not repoint the original event's tenant or payload.
export const offlineTransitionEffects = pgTable('offline_transition_effects', {
  id: uuid('id').primaryKey(),
  transitionId: text('transition_id').notNull(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  deviceId: uuid('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull().$type<OfflineEffectPayload['type']>(),
  ruleId: uuid('rule_id'),
  cooldownUntil: timestamp('cooldown_until', { withTimezone: true }),
  payload: jsonb('payload').notNull().$type<OfflineEffectPayload>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
  attempts: integer('attempts').notNull().default(0),
  leaseToken: uuid('lease_token'),
  leaseUntil: timestamp('lease_until', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  lastError: text('last_error'),
}, (t) => [
  index('offline_effects_org_idx').on(t.orgId),
  index('offline_effects_device_rule_created_idx').on(t.deviceId, t.ruleId, t.createdAt),
  index('offline_effects_completed_idx').on(t.completedAt),
  // Partial due-work index is declared in the migration.
]);
export type OfflineEffect = typeof offlineTransitionEffects.$inferSelect;
