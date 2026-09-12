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

/**
 * Durable revocation intent for an issued Checkout session (SEC-150).
 *
 * `active` — payable, nothing asked of it.
 * `revocation_requested` — a transition asked for it to die; no producer may
 *   mint a new session for the invoice and the worker keeps calling
 *   sessions.expire until it succeeds.
 * `revoked` — provably non-payable (expired, already expired, or missing).
 * `revocation_blocked` — terminal-but-unrepaired: the credential is gone/dead,
 *   the ladder ran out, or an operator abandoned it. Surfaced to the partner.
 * `charged_repair` — the session reported PAID after revocation was requested.
 *   Provider truth wins; a human reconciles.
 * `legacy_unbounded` — minted before this contract existed; revocable, but
 *   flagged so an old row is never mistaken for one the new code issued.
 */
export const stripeSessionRevocationStateEnum = pgEnum('stripe_session_revocation_state', [
  'active', 'revocation_requested', 'revoked',
  'revocation_blocked', 'charged_repair', 'legacy_unbounded'
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

/**
 * Partner-axis (RLS shape 3) archive of SUPERSEDED Stripe credentials.
 *
 * A Checkout session can only be expired with a key for the account that minted
 * it, so overwriting the single `stripe_connect_accounts.api_key` on a rotation
 * used to make every open session permanently unrevocable. Superseded keys land
 * here (encrypted, system-context reads only, every decrypt audited) until every
 * dependent session mapping is terminal AND 120 days have passed — Stripe's outer
 * dispute window — with a 400-day hard cap. Tenant erasure still wins: the table
 * carries `partner_id`, so cascadeDeletePartner's information_schema-driven sweep
 * deletes it with the partner regardless of the retention window.
 */
export const stripeConnectCredentials = pgTable('stripe_connect_credentials', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  stripeConnectionId: uuid('stripe_connection_id').notNull(),
  stripeAccountId: text('stripe_account_id').notNull(),
  // Encrypted via secretCrypto. NULL once erased — the row survives as the
  // forensic record of what was retained and when it was destroyed.
  apiKey: text('api_key'),
  keyLast4: varchar('key_last4', { length: 4 }),
  livemode: boolean('livemode').notNull().default(false),
  // Monotonic per connection; the LIVE key is always max+1 and is never stored here.
  generation: integer('generation').notNull(),
  supersededAt: timestamp('superseded_at', { withTimezone: true }).notNull().defaultNow(),
  eraseAfter: timestamp('erase_after', { withTimezone: true }).notNull(),
  eraseHardCapAt: timestamp('erase_hard_cap_at', { withTimezone: true }).notNull(),
  erasedAt: timestamp('erased_at', { withTimezone: true }),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  foreignKey({
    name: 'stripe_connect_credentials_connection_partner_fk',
    columns: [t.stripeConnectionId, t.partnerId],
    foreignColumns: [stripeConnectAccounts.id, stripeConnectAccounts.partnerId],
  }),
  uniqueIndex('stripe_connect_credentials_generation_uq').on(t.stripeConnectionId, t.generation),
  index('stripe_connect_credentials_partner_idx').on(t.partnerId),
  index('stripe_connect_credentials_account_idx').on(t.stripeAccountId),
  index('stripe_connect_credentials_erase_idx').on(t.eraseAfter).where(sql`${t.erasedAt} IS NULL`),
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
  // --- SEC-150 durable Checkout-session revocation intent + retry ladder ---
  revocationState: stripeSessionRevocationStateEnum('revocation_state').notNull().default('active'),
  revocationReason: text('revocation_reason'),
  revocationRequestedAt: timestamp('revocation_requested_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revocationAttempts: integer('revocation_attempts').notNull().default(0),
  revocationNextAttemptAt: timestamp('revocation_next_attempt_at', { withTimezone: true }),
  revocationLastError: text('revocation_last_error'),
  revocationLastProviderCode: text('revocation_last_provider_code'),
  revocationRequestedByUserId: uuid('revocation_requested_by_user_id').references(() => users.id),
  // NULL = the partner's LIVE key still belongs to this row's account. Set when a
  // key rotation or disconnect archives the outgoing credential, so the worker can
  // still expire sessions the old key minted.
  revocationCredentialId: uuid('revocation_credential_id').references(() => stripeConnectCredentials.id),
  // Defence in depth: the provider-side bound we asked Stripe for at creation.
  providerExpiresAt: timestamp('provider_expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (t) => [
  uniqueIndex('invoice_stripe_payments_object_uq').on(t.stripeObjectId),
  index('invoice_stripe_payments_revocation_due_idx')
    .on(t.revocationNextAttemptAt, t.id)
    .where(sql`${t.revocationState} = 'revocation_requested'`),
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
  paymentIntentId: text('payment_intent_id'),
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
