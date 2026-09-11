import { pgTable, pgEnum, uuid, varchar, text, date, integer, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations } from './orgs';
import { users } from './users';
import { contracts } from './contracts';
import { tickets } from './portal';
import { ticketCategories } from './tickets';
import { reports, reportRuns } from './reports';

export const deliverableCadenceEnum = pgEnum('deliverable_cadence', ['monthly', 'quarterly', 'semiannual', 'annual', 'one_time']);
export const deliverableCompletionModeEnum = pgEnum('deliverable_completion_mode', ['explicit', 'on_ticket_resolve']);
export const deliverableOccurrenceStatusEnum = pgEnum('deliverable_occurrence_status', ['scheduled', 'open', 'awaiting_evidence', 'delivered', 'missed', 'waived']);
export const deliverableEvidenceKindEnum = pgEnum('deliverable_evidence_kind', ['document', 'report_run']);

/**
 * Spec #5573 §4.1. Org-owned; contract link optional. Composite FKs
 * `(contract_id, org_id)`, `(auto_evidence_report_id, org_id)` are declared in SQL
 * only (Drizzle cannot express DEFERRABLE); the single-column references here are
 * for typing.
 */
export const serviceDeliverables = pgTable('service_deliverables', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  contractId: uuid('contract_id').references(() => contracts.id),
  name: varchar('name', { length: 200 }).notNull(),
  description: text('description'),
  cadence: deliverableCadenceEnum('cadence').notNull(),
  anchorDueDate: date('anchor_due_date').notNull(),
  effectiveFrom: date('effective_from').notNull(),
  effectiveUntil: date('effective_until'),
  leadDays: integer('lead_days').notNull().default(7),
  graceDays: integer('grace_days').notNull().default(14),
  artifactRequired: boolean('artifact_required').notNull().default(true),
  completionMode: deliverableCompletionModeEnum('completion_mode').notNull().default('on_ticket_resolve'),
  autoEvidenceReportId: uuid('auto_evidence_report_id').references(() => reports.id),
  ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
  ticketCategoryId: uuid('ticket_category_id').references(() => ticketCategories.id, { onDelete: 'set null' }),
  portalVisible: boolean('portal_visible').notNull().default(true),
  active: boolean('active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('service_deliverables_id_org_uq').on(t.id, t.orgId),
  uniqueIndex('service_deliverables_org_contract_name_uq').on(t.orgId, sql`COALESCE(${t.contractId}, '00000000-0000-0000-0000-000000000000'::uuid)`, t.name),
  index('service_deliverables_org_idx').on(t.orgId),
  index('service_deliverables_contract_idx').on(t.contractId).where(sql`${t.contractId} IS NOT NULL`),
]);

/** Spec #5573 §4.2. UNIQUE (deliverable_id, period_start) is the sweep's idempotency claim. */
export const serviceDeliverableOccurrences = pgTable('service_deliverable_occurrences', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  deliverableId: uuid('deliverable_id').notNull().references(() => serviceDeliverables.id, { onDelete: 'cascade' }),
  nameSnapshot: varchar('name_snapshot', { length: 200 }).notNull(),
  periodStart: date('period_start').notNull(),
  periodEnd: date('period_end').notNull(),
  dueAt: date('due_at').notNull(),
  originalDueAt: date('original_due_at').notNull(),
  status: deliverableOccurrenceStatusEnum('status').notNull().default('scheduled'),
  ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'set null' }),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  deliveredByUserId: uuid('delivered_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  /** `explicit` deliveries are never undone by a ticket reopen (spec §6). */
  deliveredVia: text('delivered_via').$type<'explicit' | 'ticket'>(),
  deliveryNote: text('delivery_note'),
  waivedAt: timestamp('waived_at', { withTimezone: true }),
  waivedByUserId: uuid('waived_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  waivedReason: text('waived_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('sd_occ_id_org_uq').on(t.id, t.orgId),
  uniqueIndex('sd_occ_deliverable_period_uq').on(t.deliverableId, t.periodStart),
  index('sd_occ_org_status_due_idx').on(t.orgId, t.status, t.dueAt),
  index('sd_occ_ticket_idx').on(t.ticketId).where(sql`${t.ticketId} IS NOT NULL`),
]);

/** Spec #5573 §4.3. `document_id`'s FK to org_documents is added by W03. */
export const serviceDeliverableEvidence = pgTable('service_deliverable_evidence', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  occurrenceId: uuid('occurrence_id').notNull().references(() => serviceDeliverableOccurrences.id, { onDelete: 'cascade' }),
  kind: deliverableEvidenceKindEnum('kind').notNull(),
  documentId: uuid('document_id'),
  reportId: uuid('report_id').references(() => reports.id, { onDelete: 'cascade' }),
  reportRunId: uuid('report_run_id').references(() => reportRuns.id, { onDelete: 'cascade' }),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('sd_evidence_occurrence_idx').on(t.occurrenceId),
  index('sd_evidence_org_idx').on(t.orgId),
]);

export type ServiceDeliverableRow = typeof serviceDeliverables.$inferSelect;
export type ServiceDeliverableOccurrenceRow = typeof serviceDeliverableOccurrences.$inferSelect;
export type ServiceDeliverableEvidenceRow = typeof serviceDeliverableEvidence.$inferSelect;
