// NOTE: the SQL in migrations/ is the DDL source of truth (FKs, RLS
// policies) — see migrations/2026-07-24-org-settings-dlp.sql. Do not
// generate migrations from this definition with drizzle-kit.
import { pgTable, uuid, boolean, jsonb, timestamp } from 'drizzle-orm/pg-core';

// One row per org (org_id is the primary key, not a synthetic id).
export const workspaceOrgSettings = pgTable('workspace_org_settings', {
  orgId: uuid('org_id').primaryKey(),
  contentEnabled: boolean('content_enabled').notNull().default(false),
  dlpConfig: jsonb('dlp_config').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
