// Bare-metal recovery W04a: one row per recovery attempt started from Breeze
// boot media. See spec docs/superpowers/specs/backup/2026-09-10-bare-metal-boot-media-recovery-design.md
// Sec8.1-Sec8.2 and plan docs/superpowers/plans/backup/2026-09-10-bare-metal-w04a-recovery-codes-state-machine-checkin.md.
// Migration: apps/api/migrations/2026-10-15-160020-bare-metal-recoveries.sql.
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { devices } from './devices';
import { backupSnapshots } from './backup';
import { recoveryTokens } from './recoveryTokens';
import { users } from './users';

export const BARE_METAL_RECOVERY_STATUSES = [
  'created', 'media_booted', 'planned', 'restoring', 'validated', 'rebooted', 'checked_in', 'completed', 'failed', 'refused',
] as const;
export type BareMetalRecoveryStatus = (typeof BARE_METAL_RECOVERY_STATUSES)[number];
export const BARE_METAL_RECOVERY_TERMINAL: ReadonlySet<BareMetalRecoveryStatus> = new Set([
  'checked_in', 'completed', 'failed', 'refused',
]);

export const bareMetalRecoveries = pgTable('bare_metal_recoveries', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  deviceId: uuid('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  snapshotId: uuid('snapshot_id').references(() => backupSnapshots.id, { onDelete: 'set null' }),
  recoveryTokenId: uuid('recovery_token_id').references(() => recoveryTokens.id, { onDelete: 'set null' }),
  identity: varchar('identity', { length: 10 }).notNull().$type<'original' | 'new'>(),
  codeHash: varchar('code_hash', { length: 64 }).notNull(),
  codeExpiresAt: timestamp('code_expires_at', { withTimezone: true }).notNull(),
  codeUsedAt: timestamp('code_used_at', { withTimezone: true }),
  nonceHash: varchar('nonce_hash', { length: 64 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('created').$type<BareMetalRecoveryStatus>(),
  target: jsonb('target').$type<Record<string, unknown>>(),
  plan: jsonb('plan').$type<Record<string, unknown>>(),
  result: jsonb('result').$type<Record<string, unknown>>(),
  failureReason: text('failure_reason'),
  warnings: jsonb('warnings').$type<string[]>(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  mediaBootedAt: timestamp('media_booted_at', { withTimezone: true }),
  plannedAt: timestamp('planned_at', { withTimezone: true }),
  restoringAt: timestamp('restoring_at', { withTimezone: true }),
  validatedAt: timestamp('validated_at', { withTimezone: true }),
  rebootedAt: timestamp('rebooted_at', { withTimezone: true }),
  checkedInAt: timestamp('checked_in_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (t) => ({
  codeHashIdx: uniqueIndex('bare_metal_recoveries_code_hash_idx').on(t.codeHash),
  orgIdx: index('bare_metal_recoveries_org_idx').on(t.orgId),
  deviceIdx: index('bare_metal_recoveries_device_idx').on(t.deviceId, t.createdAt),
  tokenIdx: index('bare_metal_recoveries_token_idx').on(t.recoveryTokenId),
}));
