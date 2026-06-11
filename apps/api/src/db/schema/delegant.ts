import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

export const delegantM365Connections = pgTable(
  'delegant_m365_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    customerLabel: varchar('customer_label', { length: 128 }).notNull(),
    customerDisplayName: varchar('customer_display_name', { length: 256 }).notNull(),
    delegantOrgId: varchar('delegant_org_id', { length: 64 }).notNull(),
    delegantConnectionId: varchar('delegant_connection_id', { length: 64 }).notNull(),
    m365TenantId: varchar('m365_tenant_id', { length: 64 }).notNull(),
    status: varchar('status', { length: 32 }).notNull().default('active'),
    lastVerifiedAt: timestamp('last_verified_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    orgCustomerUniq: uniqueIndex('delegant_m365_org_customer_uniq').on(t.orgId, t.customerLabel),
    orgIdx: index('delegant_m365_org_idx').on(t.orgId),
  })
);

export type DelegantM365ConnectionRow = typeof delegantM365Connections.$inferSelect;
