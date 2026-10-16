import { integer, pgEnum, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { organizations, partners } from './orgs';
import { users } from './users';

export const AI_DEVICE_FILE_READ_LEVELS = ['off', 'no_user_profiles', 'any_with_approval'] as const;
export type AiDeviceFileReadLevel = (typeof AI_DEVICE_FILE_READ_LEVELS)[number];

export const aiDeviceFileReadLevelEnum = pgEnum('ai_device_file_read_level', AI_DEVICE_FILE_READ_LEVELS);

/**
 * AI device file read policy (spec 2026-10-15). Dual-owner (#2135): the
 * PARTNER row is the default for all its orgs, the ORG row may only tighten.
 * NULL on an org row = inherit. CHECK constraints live in
 * migrations/2026-12-29-110000-ai-data-policies.sql.
 */
export const aiDataPolicies = pgTable(
  'ai_data_policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
    partnerId: uuid('partner_id').references(() => partners.id, { onDelete: 'cascade' }),
    deviceFileReadLevel: aiDeviceFileReadLevelEnum('device_file_read_level'),
    /** NULL on a partner row = keep forever; NULL on an org row = inherit. */
    toolOutputRetentionDays: integer('tool_output_retention_days'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgUq: uniqueIndex('ai_data_policies_org_uq').on(t.orgId),
    partnerUq: uniqueIndex('ai_data_policies_partner_uq').on(t.partnerId),
  }),
);

export type AiDataPolicyRow = typeof aiDataPolicies.$inferSelect;
export type NewAiDataPolicyRow = typeof aiDataPolicies.$inferInsert;
