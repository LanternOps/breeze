import { foreignKey, index, pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { organizations, partners } from './orgs';
import { partnerServicePrincipals } from './partnerServicePrincipals';
import { tickets } from './portal';

/**
 * Idempotency claims for resource-creating Partner API ticket writes
 * (`POST /partner-api/tickets`, `POST /partner-api/tickets/:id/comments`;
 * migration 2026-12-18-100000). One row per (principal, route, key), inserted
 * in the same transaction as the resource it protects and linked to it by
 * `resourceId` (no FK: the route decides which table that id names).
 *
 * The claim is BOUND TO THE TICKET it guards (`ticketId`, ON DELETE CASCADE)
 * and denormalizes that ticket's `orgId` — shape 1 tenancy, and exactly the
 * ticket-linked child case of the cascade contract: it is registered in the
 * org cascade, on BOTH org movers (`TICKET_ORG_DENORMALIZED_TABLES` and
 * `CUSTOM_ORG_REWRITE_TABLES`, appended last on each axis) so it follows its
 * ticket across an org move, in the merge registry (`repoint`) and in the
 * export policy. Reaped by jobs/partnerApiIdempotencyRetention.ts.
 */
export const partnerApiIdempotencyKeys = pgTable('partner_api_idempotency_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  partnerServicePrincipalId: uuid('partner_service_principal_id').notNull(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  // The ticket the claim guards: the path ticket for a comment claim, the
  // created ticket (linked with the resource) for a create claim.
  ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'cascade' }),
  route: varchar('route', { length: 64 }).notNull(),
  idempotencyKey: varchar('idempotency_key', { length: 128 }).notNull(),
  requestFingerprint: varchar('request_fingerprint', { length: 64 }).notNull(),
  resourceId: uuid('resource_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  principalRouteKeyUnique: uniqueIndex('partner_api_idempotency_keys_principal_route_key_unique')
    .on(table.partnerServicePrincipalId, table.route, table.idempotencyKey),
  partnerIdx: index('partner_api_idempotency_keys_partner_idx').on(table.partnerId),
  orgIdx: index('partner_api_idempotency_keys_org_idx').on(table.orgId),
  ticketIdx: index('partner_api_idempotency_keys_ticket_idx').on(table.ticketId),
  createdAtIdx: index('partner_api_idempotency_keys_created_at_idx').on(table.createdAt),
  principalPartnerFk: foreignKey({
    columns: [table.partnerServicePrincipalId, table.partnerId],
    foreignColumns: [partnerServicePrincipals.id, partnerServicePrincipals.partnerId],
    name: 'partner_api_idempotency_keys_principal_partner_fk',
  }).onDelete('cascade'),
  orgPartnerFk: foreignKey({
    columns: [table.orgId, table.partnerId],
    foreignColumns: [organizations.id, organizations.partnerId],
    name: 'partner_api_idempotency_keys_org_partner_fk',
  }).onDelete('cascade'),
  // The claim's org follows its ticket's org (deferred by name in both movers).
  ticketOrgFk: foreignKey({
    columns: [table.ticketId, table.orgId],
    foreignColumns: [tickets.id, tickets.orgId],
    name: 'partner_api_idempotency_keys_ticket_org_fk',
  }).onDelete('cascade'),
}));
