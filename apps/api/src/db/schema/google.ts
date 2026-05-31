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
 * Per-org Google Workspace connection for the Breeze identity tools.
 *
 * One connection per Breeze org (resolved by org_id). Holds the service-account
 * credentials used for domain-wide delegation (DWD):
 *  - `adminEmail` is the super-admin the service account impersonates for Admin
 *    SDK Directory / Reports / Licensing calls.
 *  - Gmail/Calendar operations impersonate the TARGET end user instead (handled
 *    at call time in googleClient.ts, not stored here).
 *
 * `serviceAccountKey` is the full service-account JSON, encrypted at rest via
 * secretCrypto (encryptSecret / decryptForColumn). It is a domain god-key — it
 * must never be logged or returned from any read endpoint.
 */
export const googleWorkspaceConnections = pgTable(
  'google_workspace_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    customerDomain: varchar('customer_domain', { length: 253 }).notNull(),
    adminEmail: varchar('admin_email', { length: 320 }).notNull(),
    serviceAccountEmail: varchar('service_account_email', { length: 320 }).notNull(),
    serviceAccountKey: text('service_account_key').notNull(),
    status: varchar('status', { length: 32 }).notNull().default('active'),
    createdBy: uuid('created_by'),
    lastVerifiedAt: timestamp('last_verified_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    orgUniq: uniqueIndex('google_workspace_connections_org_uniq').on(t.orgId),
  })
);

export type GoogleWorkspaceConnectionRow = typeof googleWorkspaceConnections.$inferSelect;
