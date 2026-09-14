import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { devices } from './devices';
import { organizations } from './orgs';
import { aiAgentRuns } from './aiAgents';
import { reportRuns } from './reports';
import { users } from './users';

/**
 * Device function assessments (Fleet Designer W02, #5652) — "what is this
 * device for", a second axis beside the coarse, billable `device_role`.
 *
 * Tenancy: RLS shape 5 (device-id scoped, DENORMALIZED `org_id`) via a direct
 * `breeze_has_org_access(org_id)` policy, structurally pinned to its device by
 * the composite FK below. ONLY `services/deviceFunction.ts` writes here; the
 * projection on `devices.device_function` / `device_function_source` is
 * maintained by that service in the same transaction. One ACTIVE row per
 * device (partial unique); superseded rows keep the history.
 *
 * Deferrability is SQL-only (migration 2026-10-16-170700): the device FK is
 * DEFERRABLE INITIALLY DEFERRED (device-axis, org move re-points both sides in
 * separate statements), the run FK DEFERRABLE INITIALLY IMMEDIATE with
 * `ON DELETE SET NULL (run_id)` — Drizzle cannot express a column-list SET
 * NULL, so the run FK carries no onDelete here and the migration is the
 * source of truth.
 */
export const deviceFunctionAssessments = pgTable('device_function_assessments', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  deviceId: uuid('device_id').notNull(),
  functionKey: text('function_key').notNull(),
  label: text('label'),
  // NULL for a manual row (a technician states a fact, not a probability).
  confidence: numeric('confidence', { precision: 3, scale: 2 }),
  // Bounded display strings written by the designer; export excludedOpen.
  evidence: jsonb('evidence').$type<string[]>().notNull().default([]),
  source: text('source').$type<'ai' | 'manual'>().notNull(),
  runId: uuid('run_id'),
  reportRunId: uuid('report_run_id').references(() => reportRuns.id, { onDelete: 'set null' }),
  active: boolean('active').notNull().default(true),
  supersededAt: timestamp('superseded_at', { withTimezone: true }),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  deviceOrgFk: foreignKey({
    name: 'device_function_assessments_device_org_fk',
    columns: [table.deviceId, table.orgId],
    foreignColumns: [devices.id, devices.orgId],
  }).onUpdate('cascade').onDelete('cascade'),
  runOrgFk: foreignKey({
    name: 'device_function_assessments_run_org_fk',
    columns: [table.runId, table.orgId],
    foreignColumns: [aiAgentRuns.id, aiAgentRuns.orgId],
  }),
  activeDeviceUq: uniqueIndex('device_function_assessments_active_device_uq')
    .on(table.deviceId)
    .where(sql`${table.active}`),
  orgKeyIdx: index('device_function_assessments_org_key_idx')
    .on(table.orgId, table.functionKey)
    .where(sql`${table.active}`),
  deviceIdx: index('device_function_assessments_device_idx').on(table.deviceId),
  runIdx: index('device_function_assessments_run_idx')
    .on(table.runId)
    .where(sql`${table.runId} IS NOT NULL`),
  reportRunIdx: index('device_function_assessments_report_run_idx')
    .on(table.reportRunId)
    .where(sql`${table.reportRunId} IS NOT NULL`),
  createdByIdx: index('device_function_assessments_created_by_idx')
    .on(table.createdByUserId)
    .where(sql`${table.createdByUserId} IS NOT NULL`),
  sourceChk: check('device_function_assessments_source_chk', sql`${table.source} IN ('ai', 'manual')`),
  confidenceChk: check(
    'device_function_assessments_confidence_chk',
    sql`${table.confidence} IS NULL OR (${table.confidence} >= 0 AND ${table.confidence} <= 1)`,
  ),
  manualConfidenceChk: check(
    'device_function_assessments_manual_confidence_chk',
    sql`${table.source} <> 'manual' OR ${table.confidence} IS NULL`,
  ),
  keyChk: check(
    'device_function_assessments_key_chk',
    sql`${table.functionKey} ~ '^[a-z][a-z0-9_]{1,47}$' OR ${table.functionKey} ~ '^custom:[a-z0-9][a-z0-9-]{1,39}$'`,
  ),
  supersededChk: check(
    'device_function_assessments_superseded_chk',
    sql`(${table.active} AND ${table.supersededAt} IS NULL) OR (NOT ${table.active} AND ${table.supersededAt} IS NOT NULL)`,
  ),
}));

export type DeviceFunctionAssessment = typeof deviceFunctionAssessments.$inferSelect;
export type NewDeviceFunctionAssessment = typeof deviceFunctionAssessments.$inferInsert;
