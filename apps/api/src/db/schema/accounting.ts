import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  char,
  boolean,
  uniqueIndex,
  index,
  foreignKey,
  check,
} from 'drizzle-orm/pg-core';
import { partners } from './orgs';
import { users } from './users';

export const accountingConnections = pgTable('accounting_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  provider: varchar('provider', { length: 20 }).notNull(), // 'quickbooks' | 'xero'
  realmIdEncrypted: text('realm_id_encrypted'),
  accessTokenEncrypted: text('access_token_encrypted'),
  refreshTokenEncrypted: text('refresh_token_encrypted'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  environment: varchar('environment', { length: 12 }).notNull().default('production'),
  homeCurrency: char('home_currency', { length: 3 }),
  // Nullable = unknown (never captured, or the capture failed). Not restricted
  // to a fixed set of values — a cache of an external fact, same rationale as
  // homeCurrency above (multi-currency §11).
  multiCurrencyEnabled: boolean('multi_currency_enabled'),
  defaultIncomeAccountRef: varchar('default_income_account_ref', { length: 64 }),
  defaultTaxCodeRef: varchar('default_tax_code_ref', { length: 64 }),
  pushMode: varchar('push_mode', { length: 10 }).notNull().default('auto'), // 'auto' | 'manual'
  // RESERVED, unused: the Intuit webhook verifier token is app-level
  // (QBO_WEBHOOK_VERIFIER_TOKEN, config/env.ts), not per-connection — Intuit
  // issues one verifier token per app, not per realm. See Phase D decision 7.
  webhookVerifierTokenEncrypted: text('webhook_verifier_token_encrypted'),
  cdcCursor: timestamp('cdc_cursor', { withTimezone: true }),
  // Keyed HMAC of the decrypted realm id — `realm_id_encrypted` uses a random
  // IV, so it cannot be queried by value. Populated by the app
  // (backfillRealmFingerprints / upsertConnection), never by SQL. Phase D
  // Task 1 — webhook realm routing.
  realmIdFingerprint: text('realm_id_fingerprint'),
  // Per-connection QBO -> Breeze payment pull-back switch (Phase D). Defaults
  // true so an existing connected realm starts reconciling once the sweep
  // ships, rather than silently opting every partner out.
  pullPayments: boolean('pull_payments').notNull().default(true),
  // Per-connection Breeze -> QBO payment push switch (Phase D2). Defaults true,
  // matching pullPayments: a connected realm should push the payments it is
  // already pulling, rather than silently opting every partner out.
  pushPayments: boolean('push_payments').notNull().default(true),
  // Stamped only after a CDC reconcile run in which no item failed (Phase D).
  lastReconcileAt: timestamp('last_reconcile_at', { withTimezone: true }),
  status: varchar('status', { length: 20 }).notNull().default('connected'),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
  lastError: text('last_error'),
  connectedBy: uuid('connected_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  partnerProviderIdx: uniqueIndex('accounting_connections_partner_provider_idx')
    .on(table.partnerId, table.provider),
  idPartnerIdx: uniqueIndex('accounting_connections_id_partner_idx').on(table.id, table.partnerId),
  // Webhook realm routing: exactly one connection per (provider, fingerprint).
  // Partial index because the fingerprint is null until backfilled.
  providerRealmFpIdx: uniqueIndex('accounting_connections_provider_realm_fp_idx')
    .on(table.provider, table.realmIdFingerprint)
    .where(sql`${table.realmIdFingerprint} IS NOT NULL`),
}));

export const accountingEntityMappings = pgTable('accounting_entity_mappings', {
  id: uuid('id').primaryKey().defaultRandom(),
  integrationId: uuid('integration_id').notNull(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  breezeEntityType: varchar('breeze_entity_type', { length: 20 }).notNull(),
  breezeEntityId: uuid('breeze_entity_id').notNull(),
  remoteEntityType: varchar('remote_entity_type', { length: 20 }).notNull(),
  remoteEntityId: text('remote_entity_id'),
  remoteSyncToken: varchar('remote_sync_token', { length: 64 }),
  // Customer's CurrencyRef.value as reported by QuickBooks (multi-currency
  // §11 / Phase C). Org rows only — a catalog item syncs once per partner with
  // no per-currency identity of its own, so this stays null for `catalog_item`
  // mapping rows.
  remoteCurrencyCode: char('remote_currency_code', { length: 3 }),
  // QBO-assigned DocNumber on a collision (QuickBooks silently renumbers a
  // duplicate DocNumber rather than rejecting it) — Phase C invoice push.
  remoteDocNumber: varchar('remote_doc_number', { length: 40 }),
  linkStatus: varchar('link_status', { length: 20 }).notNull().default('suggested'),
  syncStatus: varchar('sync_status', { length: 30 }).notNull().default('pending'),
  // TRUE for every mapping Breeze's own push created (payments here; invoices
  // by the Task-1 backfill). The CDC pull needs origin LOCALLY because a
  // deletion notification carries no PrivateNote to read it from.
  breezeOrigin: boolean('breeze_origin').notNull().default(false),
  // The operation this row still owes QuickBooks. NULL = nothing owed. Written
  // in the SAME transaction as the invoice_payments insert/delete, which is what
  // makes the mapping row the outbox rather than the BullMQ job.
  pendingOp: varchar('pending_op', { length: 10 }),
  // Worker lease. A claim is a compare-and-set on (pending_op IS NOT NULL AND
  // (claimed_at IS NULL OR claimed_at < now() - 10 min)).
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  connectionPartnerFk: foreignKey({
    columns: [table.integrationId, table.partnerId],
    foreignColumns: [accountingConnections.id, accountingConnections.partnerId],
    name: 'accounting_entity_mappings_connection_partner_fk',
  }).onDelete('cascade'),
  entityTypeCheck: check(
    'accounting_entity_mappings_entity_type_chk',
    sql`${table.breezeEntityType} IN ('org', 'catalog_item', 'invoice', 'payment')`,
  ),
  entityPairCheck: check(
    'accounting_entity_mappings_entity_pair_chk',
    sql`(${table.breezeEntityType} = 'org' AND ${table.remoteEntityType} = 'Customer') OR
        (${table.breezeEntityType} = 'catalog_item' AND ${table.remoteEntityType} = 'Item') OR
        (${table.breezeEntityType} = 'invoice' AND ${table.remoteEntityType} = 'Invoice') OR
        (${table.breezeEntityType} = 'payment' AND ${table.remoteEntityType} = 'Payment')`,
  ),
  linkStatusCheck: check(
    'accounting_entity_mappings_link_status_chk',
    sql`${table.linkStatus} IN ('suggested', 'confirmed', 'unlinked', 'create_new')`,
  ),
  syncStatusCheck: check(
    'accounting_entity_mappings_sync_status_chk',
    sql`${table.syncStatus} IN ('pending', 'synced', 'error', 'synced_with_tax_variance')`,
  ),
  pendingOpCheck: check(
    'accounting_entity_mappings_pending_op_chk',
    sql`${table.pendingOp} IS NULL OR ${table.pendingOp} IN ('push', 'delete')`,
  ),
  pendingOpIdx: index('accounting_entity_mappings_pending_op_idx')
    .on(table.partnerId, table.pendingOp)
    .where(sql`${table.pendingOp} IS NOT NULL`),
  breezeEntityUniq: uniqueIndex('accounting_entity_mappings_breeze_uniq')
    .on(table.integrationId, table.breezeEntityType, table.breezeEntityId),
  remoteEntityUniq: uniqueIndex('accounting_entity_mappings_remote_uniq')
    .on(table.integrationId, table.remoteEntityType, table.remoteEntityId)
    .where(sql`${table.remoteEntityId} IS NOT NULL`),
  partnerStatusIdx: index('accounting_entity_mappings_partner_status_idx')
    .on(table.partnerId, table.syncStatus),
}));

export type AccountingEntityMapping = typeof accountingEntityMappings.$inferSelect;
export type NewAccountingEntityMapping = typeof accountingEntityMappings.$inferInsert;
