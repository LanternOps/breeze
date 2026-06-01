import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { organizations } from './orgs';

/**
 * Per-org Microsoft 365 connection for the Breeze identity tools.
 *
 * One connection per Breeze org (resolved by org_id). Holds the app-registration
 * credentials for a client-credentials Graph flow:
 *  - `tenantId` + `clientId` identify the Azure AD app registration.
 *  - `clientSecret` is the app secret, encrypted at rest via secretCrypto
 *    (the column holds ciphertext, never plaintext). It is an admin god-key for
 *    the tenant — it must never be logged or returned from any read endpoint.
 *
 * Distinct from `delegant_m365_connections` (a lighter delegated-reference model
 * that stores no secret) and `c2c_connections` (cloud-to-cloud backup). The
 * token-acquisition logic is shared via services/c2cM365.ts.
 */
export const m365Connections = pgTable(
  'm365_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    tenantId: varchar('tenant_id', { length: 64 }).notNull(),
    clientId: varchar('client_id', { length: 64 }).notNull(),
    clientSecret: text('client_secret').notNull(),
    displayName: varchar('display_name', { length: 256 }),
    status: varchar('status', { length: 32 }).notNull().default('active'),
    createdBy: uuid('created_by'),
    lastVerifiedAt: timestamp('last_verified_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    orgUniq: uniqueIndex('m365_connections_org_uniq').on(t.orgId),
  })
);

export type M365ConnectionRow = typeof m365Connections.$inferSelect;
