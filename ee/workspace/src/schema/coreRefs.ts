// Read-only references to core-platform tables that Workspace does NOT own.
//
// These declarations exist solely so scoped read queries can be expressed in
// Drizzle. Workspace never migrates, writes, or extends these tables — the
// platform owns their DDL and their RLS policies. Only the columns Workspace
// actually reads are declared; do not grow this file into a mirror of the
// platform schema.
import { pgTable, uuid } from 'drizzle-orm/pg-core';

export const devices = pgTable('devices', {
  id: uuid('id').primaryKey(),
  orgId: uuid('org_id').notNull(),
});
