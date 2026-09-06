import { pgTable, uuid, varchar, text, timestamp, jsonb, pgEnum, integer, boolean, numeric, char, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { ImpactWeightOverrides } from '@breeze/shared';

export const partnerTypeEnum = pgEnum('partner_type', ['msp', 'enterprise', 'internal']);
// `offboarding` (#2774) is the terminal-intent drain state: users locked out
// immediately, agents kept authenticated in a narrowed self_uninstall-only
// mode until the fleet drains or the window closes, then severed + `churned`.
export const partnerStatusEnum = pgEnum('partner_status', ['pending', 'active', 'suspended', 'churned', 'offboarding']);
export type PartnerStatus = typeof partnerStatusEnum.enumValues[number];
export const partnerTrustStateEnum = pgEnum('partner_trust_state', ['probation', 'trusted', 'restricted']);
export type PartnerTrustState = (typeof partnerTrustStateEnum.enumValues)[number];
export const ipClassEnum = pgEnum('ip_class', ['residential', 'business', 'hosting', 'vpn', 'tor', 'unknown']);
export type IpClass = (typeof ipClassEnum.enumValues)[number];
export const planTypeEnum = pgEnum('plan_type', ['free', 'starter', 'community', 'pro', 'enterprise', 'unlimited']);
// 'quick_support' is the hidden per-partner org that holds ephemeral Quick
// Support devices and support_sessions rows. Exactly one per partner
// (organizations_partner_quick_support_uniq). It must stay inside
// accessibleOrgIds so RLS lets techs reach their own support sessions, but it
// is excluded from every user-facing org enumeration and device/billing count.
export const orgTypeEnum = pgEnum('org_type', ['customer', 'internal', 'quick_support']);
export const orgStatusEnum = pgEnum('org_status', ['active', 'suspended', 'trial', 'churned', 'offboarding', 'merging', 'archived', 'purging']);

export const partners = pgTable('partners', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 100 }).notNull().unique(),
  inboundLocalPart: varchar('inbound_local_part', { length: 63 }),
  type: partnerTypeEnum('type').notNull().default('msp'),
  plan: planTypeEnum('plan').notNull().default('free'),
  status: partnerStatusEnum('status').notNull().default('active'),
  maxOrganizations: integer('max_organizations'),
  maxDevices: integer('max_devices'),
  // First-class partner timezone (issue #1318). The canonical default that a tz
  // field resolves to when no more-specific scope (explicit/site/org) is set.
  // Kept in sync with the legacy `settings.timezone` JSONB key, which remains
  // the UI write target until the full call-site migration lands.
  timezone: varchar('timezone', { length: 64 }).notNull().default('UTC'),
  settings: jsonb('settings').default({}),
  ssoConfig: jsonb('sso_config'),
  billingEmail: varchar('billing_email', { length: 255 }),
  // Plain-text signature appended to outbound customer emails (quote sends).
  emailSignature: text('email_signature'),
  // Auto-email the issued invoice (with its public pay link) when a quote is
  // accepted. Dedicated column, not settings JSONB — the settings cards replace
  // sub-objects wholesale (#3597), and a column keeps gate === read-back.
  autoEmailInvoiceOnQuoteAccept: boolean('auto_email_invoice_on_quote_accept').notNull().default(true),
  // P2-6 (#4193). PARTIAL overrides of DEFAULT_IMPACT_WEIGHTS (@breeze/shared);
  // NULL means "defaults". Dedicated column, not a partners.settings
  // sub-object — settings cards replace sub-objects wholesale (#3597) and
  // would silently drop the weights. Never read directly — always through
  // resolveImpactWeights().
  aiImpactWeights: jsonb('ai_impact_weights').$type<ImpactWeightOverrides | null>(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  deletedAt: timestamp('deleted_at'),
  mcpOrigin: boolean('mcp_origin').notNull().default(false),
  mcpOriginIp: text('mcp_origin_ip'),
  mcpOriginUserAgent: text('mcp_origin_user_agent'),
  // Signup attribution for web registrations (abuse detection). MCP-originated
  // signups already record mcp_origin_ip/mcp_origin_user_agent above.
  signupIp: varchar('signup_ip', { length: 45 }),
  signupUserAgent: text('signup_user_agent'),
  // Partner trust probation (spec 2026-09-02). Lifecycle stays in `status`;
  // this is the capability axis. Default 'trusted' grandfathers every
  // pre-existing partner; register-partner sets 'probation' under enforce.
  trustState: partnerTrustStateEnum('trust_state').notNull().default('trusted'),
  trustChangedAt: timestamp('trust_changed_at', { withTimezone: true }),
  // FK partners_trust_changed_by_fkey is defined in the SQL migration because
  // users.ts imports partners from this file, making a Drizzle reference cyclic.
  trustChangedBy: uuid('trust_changed_by'),
  trustReason: text('trust_reason'),
  trustReviewRequestedAt: timestamp('trust_review_requested_at', { withTimezone: true }),
  // Lifetime count of agent enrollments made while in probation. Never
  // decremented: deleting a device must not recycle the probation quota.
  probationEnrollments: integer('probation_enrollments').notNull().default(0),
  signupIpClass: ipClassEnum('signup_ip_class').notNull().default('unknown'),
  signupIpAsn: integer('signup_ip_asn'),
  signupIpClassifiedAt: timestamp('signup_ip_classified_at', { withTimezone: true }),
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  paymentMethodAttachedAt: timestamp('payment_method_attached_at', { withTimezone: true }),
  stripeCustomerId: text('stripe_customer_id'),
  // Billing identity snapshot, written ONLY by the separate billing service
  // from its payment-provider webhooks and read only by the abuse sweep
  // (services/abuseSignals/billingIdentity.ts). Internal columns — never add
  // any of these to partnerPublicColumns() in routes/orgs.ts.
  // billingCardFingerprint is NULL for wallet/Link-style payments that expose
  // no fingerprint, so readers must treat NULL as "unknown", never as a match.
  billingCardholderName: text('billing_cardholder_name'),
  billingCardCountry: char('billing_card_country', { length: 2 }),
  billingCardFingerprint: text('billing_card_fingerprint'),
  billingDistinctPaymentMethods: integer('billing_distinct_payment_methods').notNull().default(0),
  // Bounds of the interval the distinct-method count was accumulated over.
  // billing.card_testing fires on the SPAN between these, never on the count
  // alone. NULL means "unknown span" and must fail closed, never zero.
  billingPaymentMethodsFirstSeenAt: timestamp('billing_payment_methods_first_seen_at', { withTimezone: true }),
  billingPaymentMethodsLastSeenAt: timestamp('billing_payment_methods_last_seen_at', { withTimezone: true }),
  billingFailedAttempts: integer('billing_failed_attempts').notNull().default(0),
  billingIdentitySyncedAt: timestamp('billing_identity_synced_at', { withTimezone: true }),
  billingSubscriptionStatus: text('billing_subscription_status'),
  currencyCode: char('currency_code', { length: 3 }).notNull().default('USD'),
  defaultTaxRate: numeric('default_tax_rate', { precision: 8, scale: 5 }),
  invoiceNumberPrefix: varchar('invoice_number_prefix', { length: 12 }).notNull().default('INV'),
  invoiceTermsDays: integer('invoice_terms_days').notNull().default(30),
  invoiceFooter: text('invoice_footer'),
  // Document presentation (Spec A): curated theme preset + page size for
  // quote PDFs/HTML. Partner-owned deliberately (MSP identity, not per-org
  // config) — see the spec's carve-out justification.
  documentTheme: varchar('document_theme', { length: 32 }).notNull().default('classic'),
  documentPageSize: varchar('document_page_size', { length: 8 }).notNull().default('letter'),
  billingCompanyName: varchar('billing_company_name', { length: 255 }),
  billingPhone: varchar('billing_phone', { length: 40 }),
  billingWebsite: varchar('billing_website', { length: 255 }),
  billingAddressLine1: varchar('billing_address_line1', { length: 255 }),
  billingAddressLine2: varchar('billing_address_line2', { length: 255 }),
  billingAddressCity: varchar('billing_address_city', { length: 120 }),
  billingAddressRegion: varchar('billing_address_region', { length: 120 }),
  billingAddressPostalCode: varchar('billing_address_postal_code', { length: 40 }),
  billingAddressCountry: char('billing_address_country', { length: 2 }),
  billingTermsAndConditions: text('billing_terms_and_conditions'),
  // Default markup over distributor cost (percent) used to pre-fill the listed
  // price when importing catalog items; feeds the catalog `markupPercent` field.
  // Percent value 0..9999.99. (The import view shows the resulting gross margin
  // alongside.)
  defaultMarkupPercent: numeric('default_markup_percent', { precision: 6, scale: 2 }),
  // When true (default), hardware catalog items are pre-flagged as taxable when
  // added or imported. Partners can opt out if their jurisdiction treats hardware
  // as non-taxable or they prefer to set taxability item-by-item.
  autoTaxHardware: boolean('auto_tax_hardware').notNull().default(true),
  // #3205 W07: partner default for the "Billed devices" appendix on invoice
  // PDFs. A dedicated column, for the reason autoEmailInvoiceOnQuoteAccept
  // states: settings cards replace sub-objects wholesale (#3597), and a column
  // keeps gate === read-back with no #3608 stored-false ambiguity. Resolved
  // ONCE at issue onto invoices.device_appendix; never read at render time.
  invoiceDeviceAppendix: boolean('invoice_device_appendix').notNull().default(false),
  // Partner-authored AI copy style for enrich/polish (NULL = built-in house
  // format: generic customer-friendly name + "• "-bulleted spec description).
  catalogAiStyle: text('catalog_ai_style'),
  // AI for Office is a per-partner entitlement the platform operator grants
  // (off by default). The session-minting exchange and the /client-ai/admin
  // surface gate on this; it is NOT in settings JSONB because that is
  // partner-writable and the partner must not be able to self-enable.
  aiForOfficeEnabled: boolean('ai_for_office_enabled').notNull().default(false),
  // #2774 — NULL = not offboarding. Set on drain entry, cleared on
  // abort/finalize. Drain deadline = this + OFFBOARDING_DRAIN_WINDOW_HOURS.
  offboardingStartedAt: timestamp('offboarding_started_at', { withTimezone: true }),
});

/**
 * Name of the per-partner, case-insensitive, lifetime slug uniqueness index
 * (#3967 — migrations/2026-09-08-organizations-partner-slug-unique.sql).
 *
 * Exported and used by the `uniqueIndex()` call below so there is exactly ONE
 * place this string is written: every handler that maps its 23505 to a 409 has
 * to name the index EXACTLY (an unconstrained "any 23505 is a slug conflict"
 * check misdiagnoses every other unique violation raised by the same statement
 * — #3982), and a name that only matched by copy-paste is a silent way for
 * that mapping to stop firing.
 */
export const ORG_SLUG_UNIQUE_INDEX = 'organizations_partner_slug_uniq';

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  name: varchar('name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 100 }).notNull(),
  type: orgTypeEnum('type').notNull().default('customer'),
  status: orgStatusEnum('status').notNull().default('active'),
  maxDevices: integer('max_devices'),
  settings: jsonb('settings').default({}),
  ssoConfig: jsonb('sso_config'),
  contractStart: timestamp('contract_start'),
  contractEnd: timestamp('contract_end'),
  billingContact: jsonb('billing_contact'),
  taxId: varchar('tax_id', { length: 100 }),
  taxExempt: boolean('tax_exempt').notNull().default(false),
  taxRate: numeric('tax_rate', { precision: 8, scale: 5 }),
  billingAddressLine1: varchar('billing_address_line1', { length: 255 }),
  billingAddressLine2: varchar('billing_address_line2', { length: 255 }),
  billingAddressCity: varchar('billing_address_city', { length: 120 }),
  billingAddressRegion: varchar('billing_address_region', { length: 120 }),
  billingAddressPostalCode: varchar('billing_address_postal_code', { length: 40 }),
  billingAddressCountry: char('billing_address_country', { length: 2 }),
  // Multi-currency (spec §5): the org's billing currency, inherited from the
  // partner at creation. Deliberately NO .default() — every creation path must
  // stamp it explicitly, so a missed path is a loud insert failure, never a
  // silent USD document. Editing is NOT exposed until wave 6.
  currencyCode: char('currency_code', { length: 3 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  partnerExportUpdatedAt: timestamp('partner_export_updated_at', { precision: 3 }).defaultNow().notNull(),
  // #2774 — NULL = not offboarding. Set on drain entry, cleared on
  // abort/finalize. Drain deadline = this + OFFBOARDING_DRAIN_WINDOW_HOURS.
  offboardingStartedAt: timestamp('offboarding_started_at', { withTimezone: true }),
  // Org lifecycle (spec 2026-08-26): NULL until archived; purgeAt NULL = keep forever.
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  purgeAt: timestamp('purge_at', { withTimezone: true }),
  // Which terminal status finalizeOrganizationOffboarding lands on.
  offboardingTarget: varchar('offboarding_target', { length: 16 }).notNull().default('churn'),
  deletedAt: timestamp('deleted_at')
}, (table) => ({
  orgPartnerUnique: uniqueIndex('organizations_id_partner_id_unique').on(table.id, table.partnerId),
  // #3967 — slug uniqueness is PER PARTNER, case-insensitive, and lifetime
  // (soft-deleted rows still hold their slug). Rationale and the evidence for
  // each of those three choices live in
  // migrations/2026-09-08-organizations-partner-slug-unique.sql. Do NOT
  // downgrade this to a bare `.unique()` on the column: that would mean a
  // GLOBAL namespace and would stop two unrelated MSPs both onboarding an
  // "acme".
  partnerSlugUnique: uniqueIndex(ORG_SLUG_UNIQUE_INDEX).on(table.partnerId, sql`lower(${table.slug})`),
}));

export const sites = pgTable('sites', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: varchar('name', { length: 255 }).notNull(),
  address: jsonb('address'),
  timezone: varchar('timezone', { length: 50 }).notNull().default('UTC'),
  contact: jsonb('contact'),
  settings: jsonb('settings').default({}),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  partnerExportUpdatedAt: timestamp('partner_export_updated_at', { precision: 3 }).defaultNow().notNull()
}, (table) => ({
  idOrgUnique: uniqueIndex('sites_id_org_id_uniq').on(table.id, table.orgId),
}));

export const enrollmentKeys = pgTable('enrollment_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  siteId: uuid('site_id').references(() => sites.id),
  name: varchar('name', { length: 255 }).notNull(),
  key: varchar('key', { length: 64 }).notNull().unique(),
  keySecretHash: varchar('key_secret_hash', { length: 64 }),
  usageCount: integer('usage_count').notNull().default(0),
  maxUsage: integer('max_usage'),
  expiresAt: timestamp('expires_at'),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  shortCode: varchar('short_code', { length: 12 }),
  installerPlatform: varchar('installer_platform', { length: 16 }),
  // Enrollment idempotency (#2764): set when this key was minted to redeem a
  // bootstrap token (Task 2), so a later cancel/refund (Task 3) can find and
  // release the originating token's slot.
  bootstrapTokenId: uuid('bootstrap_token_id'),
  // Quick Support: set on the single-use child key minted by /support/redeem.
  // Plain uuid — the FK lives in SQL to avoid a circular import with
  // supportSessions.ts (which imports organizations from this file).
  supportSessionId: uuid('support_session_id'),
});

// Durable "loser merged into survivor" record (spec 2026-08-26). loser_org_id
// deliberately has no FK — the loser org row is erased after the merge.
export const orgMergeEvents = pgTable('org_merge_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  loserOrgId: uuid('loser_org_id').notNull(),
  loserOrgName: varchar('loser_org_name', { length: 255 }).notNull(),
  survivorOrgId: uuid('survivor_org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  actorUserId: uuid('actor_user_id'),
  summary: jsonb('summary').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
