// apps/api/src/db/schema/stripePayments.ts
import {
  pgTable, uuid, text, varchar, boolean, numeric, jsonb, timestamp, char, pgEnum,
  index, uniqueIndex, integer, date, bigint, foreignKey
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { partners, organizations } from './orgs';
import { users } from './users';
import { invoices, invoicePayments } from './invoices';

export const stripeConnectStatusEnum = pgEnum('stripe_connect_status', [
  'connected', 'disconnected'
]);

export const stripePaymentObjectTypeEnum = pgEnum('stripe_payment_object_type', [
  'checkout_session', 'payment_intent', 'charge'
]);

export const stripePaymentStatusEnum = pgEnum('stripe_payment_status', [
  'pending', 'succeeded', 'failed', 'refunded', 'partially_refunded',
  'disputed', 'partially_disputed'
]);

export const stripeFinancialEventStatusEnum = pgEnum('stripe_financial_event_status', [
  'pending', 'applied', 'ignored', 'blocked'
]);

// Partner-axis (RLS shape 3). One connected Stripe account per partner.
export const stripeConnectAccounts = pgTable('stripe_connect_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  stripeAccountId: text('stripe_account_id').notNull(),
  // Per-partner Stripe secret/restricted key, encrypted via secretCrypto. Charges
  // run directly on the partner's own account with this key (no Connect/Stripe-Account).
  apiKey: text('api_key'),
  // Plaintext last 4 of the key, for the settings UI ("•••• 1234"). Never the full key.
  keyLast4: varchar('key_last4', { length: 4 }),
  // Legacy Connect-OAuth token (unused by the API-key path; retained until a later drop migration).
  credentials: jsonb('credentials').$type<{ accessToken: string | null }>(),
  livemode: boolean('livemode').notNull().default(false),
  // Cached connected-account facts (#3777 §10); null until the key is saved under wave 5.
  defaultCurrency: char('default_currency', { length: 3 }),
  accountCountry: char('account_country', { length: 2 }),
  accountRefreshedAt: timestamp('account_refreshed_at'),
  // Durable account-event scan state. A scan pins an upper bound and resumes
  // with pageAfter so a bounded worker cannot skip an older page when more
  // than one page arrived between runs.
  financialEventCursorCreated: bigint('financial_event_cursor_created', { mode: 'number' }).notNull().default(0),
  financialEventPageAfter: text('financial_event_page_after'),
  financialEventScanUpperCreated: bigint('financial_event_scan_upper_created', { mode: 'number' }),
  financialEventLastPolledAt: timestamp('financial_event_last_polled_at', { withTimezone: true }),
  financialEventLastError: text('financial_event_last_error'),
  status: stripeConnectStatusEnum('status').notNull().default('connected'),
  // Legacy Connect-OAuth scope (unused by the API-key path; retained until a later drop migration).
  scope: varchar('scope', { length: 50 }),
  connectedBy: uuid('connected_by').references(() => users.id),
  connectedAt: timestamp('connected_at').defaultNow().notNull(),
  disconnectedAt: timestamp('disconnected_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (t) => [
  uniqueIndex('stripe_connect_accounts_partner_uq').on(t.partnerId),
  uniqueIndex('stripe_connect_accounts_acct_uq').on(t.stripeAccountId),
  uniqueIndex('stripe_connect_accounts_id_partner_uq').on(t.id, t.partnerId),
]);

// Org-axis (RLS shape 1, direct org_id). Maps a Stripe object to the recorded payment row.
export const invoiceStripePayments = pgTable('invoice_stripe_payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  invoiceId: uuid('invoice_id').notNull().references(() => invoices.id, { onDelete: 'cascade' }),
  invoicePaymentId: uuid('invoice_payment_id').references(() => invoicePayments.id, { onDelete: 'set null' }),
  stripeAccountId: text('stripe_account_id').notNull(),
  stripeObjectType: stripePaymentObjectTypeEnum('stripe_object_type').notNull(),
  stripeObjectId: text('stripe_object_id').notNull(),
  stripePaymentIntentId: text('stripe_payment_intent_id'),
  amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  status: stripePaymentStatusEnum('status').notNull().default('pending'),
  refundedAmountMinor: numeric('refunded_amount_minor', { precision: 20, scale: 0 }).notNull().default('0'),
  disputeAmountMinor: numeric('dispute_amount_minor', { precision: 20, scale: 0 }).notNull().default('0'),
  disputeFundsWithdrawn: boolean('dispute_funds_withdrawn').notNull().default(false),
  lastDisputeEventCreated: bigint('last_dispute_event_created', { mode: 'number' }),
  lastDisputeEventId: text('last_dispute_event_id'),
  paymentReceivedAt: date('payment_received_at'),
  lastEventAt: timestamp('last_event_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (t) => [
  uniqueIndex('invoice_stripe_payments_object_uq').on(t.stripeObjectId),
  uniqueIndex('invoice_stripe_payments_account_pi_uq')
    .on(t.stripeAccountId, t.stripePaymentIntentId)
    .where(sql`${t.stripePaymentIntentId} IS NOT NULL`),
  index('invoice_stripe_payments_invoice_idx').on(t.invoiceId),
  index('invoice_stripe_payments_org_idx').on(t.orgId),
  index('invoice_stripe_payments_pi_idx').on(t.stripePaymentIntentId)
]);

// Partner-axis durable inbox for normalized provider reversal events. Rows may
// intentionally remain unlinked to an org while a refund races the Checkout
// capture; the partner/account binding is therefore the tenancy boundary.
export const stripeFinancialEvents = pgTable('stripe_financial_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  stripeConnectionId: uuid('stripe_connection_id').notNull(),
  stripeAccountId: text('stripe_account_id').notNull(),
  stripeEventId: text('stripe_event_id').notNull(),
  eventType: text('event_type').notNull(),
  livemode: boolean('livemode').notNull(),
  providerCreated: bigint('provider_created', { mode: 'number' }).notNull(),
  paymentIntentId: text('payment_intent_id').notNull(),
  chargeId: text('charge_id'),
  disputeId: text('dispute_id'),
  currency: char('currency', { length: 3 }).notNull(),
  chargeAmountMinor: numeric('charge_amount_minor', { precision: 20, scale: 0 }),
  refundedAmountMinor: numeric('refunded_amount_minor', { precision: 20, scale: 0 }),
  disputeAmountMinor: numeric('dispute_amount_minor', { precision: 20, scale: 0 }),
  disputeFundsWithdrawn: boolean('dispute_funds_withdrawn'),
  payloadDigest: char('payload_digest', { length: 64 }).notNull(),
  status: stripeFinancialEventStatusEnum('status').notNull().default('pending'),
  attemptCount: integer('attempt_count').notNull().default(0),
  lastError: text('last_error'),
  lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).defaultNow(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('stripe_financial_events_event_uq').on(t.stripeEventId),
  foreignKey({
    name: 'stripe_financial_events_connection_partner_fk',
    columns: [t.stripeConnectionId, t.partnerId],
    foreignColumns: [stripeConnectAccounts.id, stripeConnectAccounts.partnerId],
  }),
  index('stripe_financial_events_pending_retry_idx').on(t.status, t.nextAttemptAt, t.providerCreated),
  index('stripe_financial_events_connection_idx').on(t.stripeConnectionId),
  index('stripe_financial_events_partner_idx').on(t.partnerId),
  index('stripe_financial_events_pi_idx').on(t.stripeAccountId, t.paymentIntentId),
]);
