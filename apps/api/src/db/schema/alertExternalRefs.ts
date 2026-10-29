import { sql } from 'drizzle-orm';
import { check, foreignKey, index, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { alerts } from './alerts';
import { organizations, partners } from './orgs';
import { partnerServicePrincipals } from './partnerServicePrincipals';

/** Principal-namespaced alert references (Shape 1). Composite FKs are
 * DEFERRABLE INITIALLY IMMEDIATE in SQL for org merge; the alert FK cascades
 * within-partner org moves. Cross-partner moves discard refs before the flip.
 * An external ticket may cover several alerts, so external_id is not unique. */
export const alertExternalRefs = pgTable('alert_external_refs', {
  id: uuid('id').primaryKey().defaultRandom(),
  alertId: uuid('alert_id').notNull().references(() => alerts.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  partnerServicePrincipalId: uuid('partner_service_principal_id').notNull(),
  externalId: varchar('external_id', { length: 255 }).notNull(),
  externalUrl: text('external_url'),
  externalNumber: varchar('external_number', { length: 255 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('alert_external_refs_alert_principal_uq').on(t.alertId, t.partnerServicePrincipalId),
  index('alert_external_refs_principal_idx').on(t.partnerServicePrincipalId),
  index('alert_external_refs_org_idx').on(t.orgId),
  index('alert_external_refs_partner_idx').on(t.partnerId),
  foreignKey({ name: 'alert_external_refs_principal_partner_fk',
    columns: [t.partnerServicePrincipalId, t.partnerId],
    foreignColumns: [partnerServicePrincipals.id, partnerServicePrincipals.partnerId],
  }).onDelete('cascade'),
  foreignKey({ name: 'alert_external_refs_org_partner_fk', columns: [t.orgId, t.partnerId],
    foreignColumns: [organizations.id, organizations.partnerId],
  }).onDelete('cascade'),
  foreignKey({ name: 'alert_external_refs_alert_org_fk', columns: [t.alertId, t.orgId],
    foreignColumns: [alerts.id, alerts.orgId],
  }).onUpdate('cascade').onDelete('cascade'),
  check('alert_external_refs_url_https_chk', sql`${t.externalUrl} IS NULL OR ${t.externalUrl} ~* '^https://'`),
]);
