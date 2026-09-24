import { pgTable, uuid, text, char, integer, boolean, numeric, timestamp } from 'drizzle-orm/pg-core';
import { partners, organizations } from './orgs';
import { users } from './users';
import { supportedCurrencies } from './currency';
import { workTypes } from './workTypes';

// Partner-axis tables. Composite same-partner FKs, CHECKs and unique indexes
// are maintained in 2026-10-24-200000-billing-profiles.sql, matching timeTracking.ts.
// The base row is columns so every profile always has an answer.
export const billingProfiles = pgTable('billing_profiles', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  name: text('name').notNull(),
  notes: text('notes'),
  currencyCode: char('currency_code', { length: 3 }).notNull().references(() => supportedCurrencies.code),
  isDefault: boolean('is_default').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  roundingIncrementMinutes: integer('rounding_increment_minutes'),
  baseCoverage: text('base_coverage').$type<'billable' | 'included' | 'non_billable'>().notNull(),
  baseHourlyRate: numeric('base_hourly_rate', { precision: 10, scale: 2 }),
  baseMinimumMinutes: integer('base_minimum_minutes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const billingProfileRules = pgTable('billing_profile_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  billingProfileId: uuid('billing_profile_id').notNull().references(() => billingProfiles.id, { onDelete: 'cascade' }),
  workTypeId: uuid('work_type_id').notNull().references(() => workTypes.id),
  coverage: text('coverage').$type<'billable' | 'included' | 'non_billable'>().notNull(),
  hourlyRate: numeric('hourly_rate', { precision: 10, scale: 2 }),
  minimumMinutes: integer('minimum_minutes'),
  notes: text('notes'),
});

export const orgBillingProfileAssignments = pgTable('org_billing_profile_assignments', {
  id: uuid('id').primaryKey().defaultRandom(),
  // SQL owns the DEFERRABLE INITIALLY IMMEDIATE (org_id, partner_id) FK.
  orgId: uuid('org_id').notNull().unique().references(() => organizations.id),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  billingProfileId: uuid('billing_profile_id').notNull().references(() => billingProfiles.id),
  assignedBy: uuid('assigned_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Read-only snapshot of the six legacy labour-pricing columns taken by
 * 2026-10-29-100300-drop-legacy-labour-pricing-columns.sql right before it
 * dropped them (#4628 W04b, #6472). skip_reason names why the conversion did
 * not carry a value into a billing profile; NULL means it did. Nothing in the
 * app writes here after that migration. Partner-axis like
 * org_billing_profile_assignments; SQL owns the CHECKs, the unique key and the
 * DEFERRABLE (org_id, partner_id) FK.
 */
export const legacyLabourPricingArchive = pgTable('legacy_labour_pricing_archive', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  orgId: uuid('org_id').references(() => organizations.id),
  sourceTable: text('source_table').$type<'ticket_categories' | 'org_ticket_settings'>().notNull(),
  sourceId: uuid('source_id').notNull(),
  sourceName: text('source_name').notNull(),
  defaultBillable: boolean('default_billable'),
  defaultHourlyRate: numeric('default_hourly_rate', { precision: 10, scale: 2 }),
  rateCurrency: char('rate_currency', { length: 3 }),
  ownerCurrencyCode: char('owner_currency_code', { length: 3 }),
  skipReason: text('skip_reason').$type<
    'org_currency_off_list' | 'org_rate_currency_mismatch' | 'non_billable_category_rate' | 'category_rate_currency_unsupported'
  >(),
  archivedAt: timestamp('archived_at', { withTimezone: true }).notNull().defaultNow(),
});

export type BillingProfile = typeof billingProfiles.$inferSelect;
export type NewBillingProfile = typeof billingProfiles.$inferInsert;
export type BillingProfileRule = typeof billingProfileRules.$inferSelect;
export type NewBillingProfileRule = typeof billingProfileRules.$inferInsert;
export type OrgBillingProfileAssignment = typeof orgBillingProfileAssignments.$inferSelect;
export type NewOrgBillingProfileAssignment = typeof orgBillingProfileAssignments.$inferInsert;
