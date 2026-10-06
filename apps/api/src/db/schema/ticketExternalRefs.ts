import { foreignKey, index, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { organizations, partners } from './orgs';
import { partnerServicePrincipals } from './partnerServicePrincipals';
import { tickets } from './portal';

/**
 * A ticket's id/url in an external PSA/ITSM, namespaced by the partner service
 * principal that owns the integration (migration 2026-12-04-101300). Shape 1
 * on `org_id`, denormalized from the ticket; has `ticket_id`, so it is
 * registered on BOTH org movers and the org-merge walk (see
 * services/ticketOrgMoveLockOrder.ts). `partner_id` is NOT NULL and both
 * composite FKs pin the row to ONE partner: the principal is of that partner
 * and so is the organization (DEFERRABLE INITIALLY IMMEDIATE, for org merge).
 * A third composite, (ticket_id, org_id) -> tickets(id, org_id), makes the
 * ref's org follow its TICKET's org; both movers defer it by name.
 */
export const ticketExternalRefs = pgTable('ticket_external_refs', {
  id: uuid('id').primaryKey().defaultRandom(),
  ticketId: uuid('ticket_id').notNull().references(() => tickets.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  partnerServicePrincipalId: uuid('partner_service_principal_id').notNull(),
  externalId: varchar('external_id', { length: 255 }).notNull(),
  externalUrl: text('external_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('ticket_external_refs_principal_external_uq').on(t.partnerServicePrincipalId, t.externalId),
  uniqueIndex('ticket_external_refs_principal_ticket_uq').on(t.partnerServicePrincipalId, t.ticketId),
  index('ticket_external_refs_ticket_idx').on(t.ticketId),
  index('ticket_external_refs_org_idx').on(t.orgId),
  index('ticket_external_refs_partner_idx').on(t.partnerId),
  foreignKey({
    columns: [t.partnerServicePrincipalId, t.partnerId],
    foreignColumns: [partnerServicePrincipals.id, partnerServicePrincipals.partnerId],
    name: 'ticket_external_refs_principal_partner_fk',
  }).onDelete('cascade'),
  foreignKey({
    columns: [t.orgId, t.partnerId],
    foreignColumns: [organizations.id, organizations.partnerId],
    name: 'ticket_external_refs_org_partner_fk',
  }).onDelete('cascade'),
  foreignKey({
    columns: [t.ticketId, t.orgId],
    foreignColumns: [tickets.id, tickets.orgId],
    name: 'ticket_external_refs_ticket_org_fk',
  }).onDelete('cascade'),
]);
