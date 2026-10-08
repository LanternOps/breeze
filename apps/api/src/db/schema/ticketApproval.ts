import { pgTable, uuid, boolean, text, integer, numeric, char, timestamp, check, unique, uniqueIndex, index, foreignKey } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, partners } from './orgs';
import { users } from './users';
import { tickets, portalUsers } from './portal';

/**
 * Customer work approval (#4617).
 * Spec: docs/superpowers/specs/ticketing/2026-10-06-customer-work-approval-design.md §4.
 */

export type TicketApprovalEnforcement = 'soft' | 'hard';
export type TicketApprovalTrigger = 'budget' | 'after_hours';
export type TicketApprovalOrigin = 'auto' | 'staff';
export type TicketApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';
export type TicketApprovalDecisionOrigin = 'customer' | 'on_behalf';
export type TicketApprovalDecisionMethod = 'verbal' | 'email' | 'signed_document' | 'other';

/**
 * Spec §4.1 — dual-axis policy (org XOR partner); a NULL column means inherit.
 * RLS (FOR ALL org-or-partner + SELECT-only partner-default branch) is in
 * 2026-12-18-150100-ticket-approval-settings.sql. Read ONLY through
 * resolveTicketApprovalSettings (services/ticketApproval/settings.ts).
 */
export const ticketApprovalSettings = pgTable('ticket_approval_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id),
  partnerId: uuid('partner_id').references(() => partners.id),
  enabled: boolean('enabled'),
  budgetTrigger: boolean('budget_trigger'),
  afterHoursTrigger: boolean('after_hours_trigger'),
  enforcement: text('enforcement').$type<TicketApprovalEnforcement>(),
  requestTtlHours: integer('request_ttl_hours'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('ticket_approval_settings_enforcement_check', sql`${t.enforcement} IN ('soft', 'hard')`),
  check('ticket_approval_settings_request_ttl_hours_check', sql`${t.requestTtlHours} BETWEEN 1 AND 720`),
  check('ticket_approval_settings_one_owner_chk', sql`(${t.orgId} IS NULL) <> (${t.partnerId} IS NULL)`),
  uniqueIndex('ticket_approval_settings_partner_uq').on(t.partnerId).where(sql`${t.partnerId} IS NOT NULL`),
  uniqueIndex('ticket_approval_settings_org_uq').on(t.orgId).where(sql`${t.orgId} IS NOT NULL`),
]);

/**
 * Spec §4.3 — one request for customer consent and its decision (Shape 1,
 * direct org_id). SQL-only (2026-12-18-150200-ticket-approval-requests.sql):
 *   - the CHECKs, including ticket_approval_requests_decision_shape_chk and
 *     ticket_approval_requests_coverage_chk;
 *   - the BEFORE UPDATE trigger ticket_approval_requests_decided_immutable,
 *     which freezes a terminal row except org_id, updated_at and the three
 *     *_user_id columns going to NULL;
 *   - RLS.
 * The composite ticket FK is DEFERRABLE INITIALLY IMMEDIATE in SQL (Drizzle
 * cannot express deferrability); both org movers name it in SET CONSTRAINTS.
 */
export const ticketApprovalRequests = pgTable('ticket_approval_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  ticketId: uuid('ticket_id').notNull(),
  trigger: text('trigger').$type<TicketApprovalTrigger>().notNull(),
  origin: text('origin').$type<TicketApprovalOrigin>().notNull(),
  status: text('status').$type<TicketApprovalStatus>().notNull().default('pending'),
  revision: integer('revision').notNull().default(1),
  enforcement: text('enforcement').$type<TicketApprovalEnforcement>().notNull(),
  requestedByUserId: uuid('requested_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  message: text('message'),
  budgetMinutesAtRequest: integer('budget_minutes_at_request'),
  consumedMinutesAtRequest: integer('consumed_minutes_at_request'),
  budgetAmountAtRequest: numeric('budget_amount_at_request', { precision: 12, scale: 2 }),
  consumedAmountAtRequest: numeric('consumed_amount_at_request', { precision: 12, scale: 2 }),
  currencyCode: char('currency_code', { length: 3 }),
  requestedExtensionMinutes: integer('requested_extension_minutes'),
  requestedExtensionAmount: numeric('requested_extension_amount', { precision: 12, scale: 2 }),
  coverageStartsAt: timestamp('coverage_starts_at', { withTimezone: true }),
  coverageEndsAt: timestamp('coverage_ends_at', { withTimezone: true }),
  // Snapshot; deliberately no FK.
  afterHoursWorkTypeId: uuid('after_hours_work_type_id'),
  approverEmails: text('approver_emails').array().notNull().default(sql`'{}'::text[]`),
  notifyEmails: text('notify_emails').array().notNull().default(sql`'{}'::text[]`),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decisionOrigin: text('decision_origin').$type<TicketApprovalDecisionOrigin>(),
  decidedByPortalUserId: uuid('decided_by_portal_user_id').references(() => portalUsers.id, { onDelete: 'set null' }),
  decidedByUserId: uuid('decided_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  signerName: text('signer_name'),
  signerEmail: text('signer_email'),
  decisionMethod: text('decision_method').$type<TicketApprovalDecisionMethod>(),
  decisionReference: text('decision_reference'),
  decisionNote: text('decision_note'),
  decidedRevision: integer('decided_revision'),
  approvedExtensionMinutes: integer('approved_extension_minutes'),
  approvedExtensionAmount: numeric('approved_extension_amount', { precision: 12, scale: 2 }),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('ticket_approval_requests_id_ticket_uq').on(t.id, t.ticketId),
  foreignKey({
    columns: [t.ticketId, t.orgId],
    foreignColumns: [tickets.id, tickets.orgId],
    name: 'ticket_approval_requests_ticket_org_fk',
  }).onDelete('cascade'),
  uniqueIndex('ticket_approval_requests_one_pending_uq').on(t.ticketId, t.trigger).where(sql`${t.status} = 'pending'`),
  index('ticket_approval_requests_sweep_idx').on(t.status, t.expiresAt),
  index('ticket_approval_requests_org_status_idx').on(t.orgId, t.status),
]);

export type TicketApprovalSettingsRow = typeof ticketApprovalSettings.$inferSelect;
export type TicketApprovalRequest = typeof ticketApprovalRequests.$inferSelect;
export type NewTicketApprovalRequest = typeof ticketApprovalRequests.$inferInsert;
