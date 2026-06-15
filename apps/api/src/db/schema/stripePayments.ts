// apps/api/src/db/schema/stripePayments.ts
import {
  pgTable, uuid, text, varchar, boolean, numeric, jsonb, timestamp, char, pgEnum,
  index, uniqueIndex
} from 'drizzle-orm/pg-core';
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
  'pending', 'succeeded', 'failed', 'refunded', 'partially_refunded'
]);

// Partner-axis (RLS shape 3). One connected Stripe account per partner.
export const stripeConnectAccounts = pgTable('stripe_connect_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  stripeAccountId: text('stripe_account_id').notNull(),
  // encrypted via secretCrypto; used only for deauthorize. Charges use platform key + Stripe-Account header.
  credentials: jsonb('credentials'),
  livemode: boolean('livemode').notNull().default(false),
  status: stripeConnectStatusEnum('status').notNull().default('connected'),
  scope: varchar('scope', { length: 50 }),
  connectedBy: uuid('connected_by').references(() => users.id),
  connectedAt: timestamp('connected_at').defaultNow().notNull(),
  disconnectedAt: timestamp('disconnected_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (t) => [
  uniqueIndex('stripe_connect_accounts_partner_uq').on(t.partnerId),
  uniqueIndex('stripe_connect_accounts_acct_uq').on(t.stripeAccountId)
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
  lastEventAt: timestamp('last_event_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (t) => [
  uniqueIndex('invoice_stripe_payments_object_uq').on(t.stripeObjectId),
  index('invoice_stripe_payments_invoice_idx').on(t.invoiceId),
  index('invoice_stripe_payments_org_idx').on(t.orgId),
  index('invoice_stripe_payments_pi_idx').on(t.stripePaymentIntentId)
]);
