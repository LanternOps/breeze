import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { FleetDesignBeforeImage, FleetDesignCreatedRefs, FleetDesignLedgerKind, FleetDesignLedgerStatus } from '@breeze/shared';
import { organizations } from './orgs';
import { reportRuns } from './reports';
import { users } from './users';

/**
 * Fleet Design apply ledger (Fleet Designer W03, #5653; spec §4.8, §4.11).
 *
 * One row per applied item ref. `UNIQUE (report_run_id, item_ref)` is the
 * idempotency key — re-applying an approval skips every ref that already has
 * an `applied` row. Rollback reads `created_refs` (what the apply made) and
 * `before_image` (what it replaced); it never trusts a jsonb manifest on the
 * report run.
 *
 * Tenancy: RLS shape 1 (direct org_id). Registered in
 * CORE_ORG_CASCADE_DELETE_ORDER, CORE_TENANT_EXPORT_POLICY (both jsonb
 * columns excludedOpen) and orgMergeRegistry REPOINT_TABLES.
 * `report_run_id` is ON DELETE CASCADE because org erasure pre-clears
 * report_runs (tenantCascade.ts). ONLY services/fleetDesign/ledger.ts writes here.
 */
export const fleetDesignAppliedItems = pgTable('fleet_design_applied_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  reportRunId: uuid('report_run_id').notNull().references(() => reportRuns.id, { onDelete: 'cascade' }),
  itemRef: text('item_ref').notNull(),
  itemKind: text('item_kind').$type<FleetDesignLedgerKind>().notNull(),
  status: text('status').$type<FleetDesignLedgerStatus>().notNull().default('applied'),
  step: smallint('step').notNull(),
  createdRefs: jsonb('created_refs').$type<FleetDesignCreatedRefs>().notNull().default({}),
  beforeImage: jsonb('before_image').$type<FleetDesignBeforeImage | null>(),
  error: text('error'),
  appliedByUserId: uuid('applied_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  appliedAt: timestamp('applied_at', { withTimezone: true }).notNull().defaultNow(),
  rolledBackByUserId: uuid('rolled_back_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  rolledBackAt: timestamp('rolled_back_at', { withTimezone: true }),
}, (table) => ({
  runRefUq: uniqueIndex('fleet_design_applied_items_run_ref_uq').on(table.reportRunId, table.itemRef),
  orgRunIdx: index('fleet_design_applied_items_org_run_idx').on(table.orgId, table.reportRunId),
  appliedByIdx: index('fleet_design_applied_items_applied_by_idx')
    .on(table.appliedByUserId)
    .where(sql`${table.appliedByUserId} IS NOT NULL`),
  rolledBackByIdx: index('fleet_design_applied_items_rolled_back_by_idx')
    .on(table.rolledBackByUserId)
    .where(sql`${table.rolledBackByUserId} IS NOT NULL`),
  kindChk: check(
    'fleet_design_applied_items_kind_chk',
    sql`${table.itemKind} IN ('function', 'policy', 'watch', 'rule', 'retired', 'script', 'role_correction')`,
  ),
  statusChk: check('fleet_design_applied_items_status_chk', sql`${table.status} IN ('applied', 'rolled_back', 'failed')`),
  stepChk: check('fleet_design_applied_items_step_chk', sql`${table.step} BETWEEN 1 AND 5`),
  rollbackChk: check(
    'fleet_design_applied_items_rollback_chk',
    sql`(${table.status} = 'rolled_back') = (${table.rolledBackAt} IS NOT NULL)`,
  ),
}));

export type FleetDesignAppliedItem = typeof fleetDesignAppliedItems.$inferSelect;
export type NewFleetDesignAppliedItem = typeof fleetDesignAppliedItems.$inferInsert;
