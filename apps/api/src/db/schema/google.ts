import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  uniqueIndex,
  index,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
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
    // Connection health W4 verification probe (services/connectionHealth/googleProbe.ts).
    lastProbeAt: timestamp('last_probe_at'),
    lastProbeStatus: varchar('last_probe_status', { length: 16 }).$type<'ok' | 'failed' | 'unavailable'>(),
    /** Sanitized (sanitizeHealthDetail), never key material. Export policy: excludedOpen. */
    lastProbeError: text('last_probe_error'),
  },
  (t) => ({
    orgUniq: uniqueIndex('google_workspace_connections_org_uniq').on(t.orgId),
    probeFailedIdx: index('google_workspace_connections_probe_failed_idx')
      .on(t.id)
      .where(sql`${t.lastProbeStatus} = 'failed'`),
    probeDueIdx: index('google_workspace_connections_probe_due_idx').on(t.lastProbeAt.asc().nullsFirst()),
    probeStatusChk: check(
      'google_workspace_connections_probe_status_chk',
      sql`${t.lastProbeStatus} IS NULL OR ${t.lastProbeStatus} IN ('ok', 'failed', 'unavailable')`,
    ),
    probeErrorLenChk: check(
      'google_workspace_connections_probe_error_len_chk',
      sql`${t.lastProbeError} IS NULL OR char_length(${t.lastProbeError}) <= 300`,
    ),
  })
);

export type GoogleWorkspaceConnectionRow = typeof googleWorkspaceConnections.$inferSelect;
