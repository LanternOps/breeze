// AI model registry W03 (#7601, Task 6A): the per-partner registry gate record.
// Migration: 2026-11-19-100400-ai-model-registry-cutover.sql. That migration
// also created ai_model_registry_state (the W03 sweep's coordinator singleton);
// W08 (#7606) removed the sweep and this declaration, and W08b drops the table.
import { pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { partners } from './orgs';

/** Shape 3 (partner axis): a row means the partner's registry rows exist (W03 projection, or the W08 bootstrap), once. */
export const aiModelRegistryPartnerCutover = pgTable('ai_model_registry_partner_cutover', {
  partnerId: uuid('partner_id').primaryKey().references(() => partners.id, { onDelete: 'cascade' }),
  cutoverAt: timestamp('cutover_at', { withTimezone: true }).notNull().defaultNow(),
});
