import { pgTable, uuid, text, varchar, boolean, integer, timestamp, jsonb, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { partners } from './orgs';
import { users } from './users';

/**
 * Partner sending domains (spec 2026-09-17-partner-sending-domains-design §3.1).
 * Tenancy: RLS shape 3 (partner-axis), no org_id and no device_id — registered
 * in PARTNER_TENANT_TABLES only. A BEFORE DELETE trigger raises when
 * provider_domain_id is still set; services/emailDomains/domainRelease.ts is
 * the path that satisfies it.
 */
export const partnerSendingDomains = pgTable('partner_sending_domains', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  domain: varchar('domain', { length: 253 }).notNull(),
  provider: varchar('provider', { length: 20 }).$type<'resend' | 'ses' | 'static' | 'fake'>().notNull(),
  providerDomainId: text('provider_domain_id'),
  providerManaged: boolean('provider_managed').notNull().default(true),
  provisionAttemptedAt: timestamp('provision_attempted_at', { withTimezone: true }),
  providerRegion: varchar('provider_region', { length: 32 }),
  status: varchar('status', { length: 20 })
    .$type<'provisioning' | 'pending' | 'verified' | 'at_risk' | 'failed' | 'suspended' | 'removing'>()
    .notNull()
    .default('provisioning'),
  statusReason: varchar('status_reason', { length: 64 }),
  dnsRecords: jsonb('dns_records').notNull().default([]),
  checkRequestedAt: timestamp('check_requested_at', { withTimezone: true }),
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
  nextCheckAt: timestamp('next_check_at', { withTimezone: true }),
  checkAttempts: integer('check_attempts').notNull().default(0),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  statusChangedAt: timestamp('status_changed_at', { withTimezone: true }).notNull().defaultNow(),
  lastTestAt: timestamp('last_test_at', { withTimezone: true }),
  lastTestStatus: varchar('last_test_status', { length: 16 }).$type<'pending' | 'sent' | 'failed'>(),
  lastTestError: text('last_test_error'),
  lastSendError: text('last_send_error'),
  lastSendErrorAt: timestamp('last_send_error_at', { withTimezone: true }),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => [
  uniqueIndex('partner_sending_domains_domain_uq').on(t.domain),
  uniqueIndex('partner_sending_domains_id_partner_uq').on(t.id, t.partnerId),
  index('partner_sending_domains_partner_idx').on(t.partnerId)
]);

/**
 * One sender identity per (partner, stream). The composite FK
 * (sending_domain_id, partner_id) -> partner_sending_domains(id, partner_id)
 * ON DELETE CASCADE is SQL-only (Drizzle's references() is single-column); see
 * the 2026-10-20-100000 migration. Deliberately NOT deferrable — there is no
 * partner merge.
 */
export const partnerSenderIdentities = pgTable('partner_sender_identities', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  sendingDomainId: uuid('sending_domain_id').notNull(),
  stream: varchar('stream', { length: 20 }).$type<'support' | 'billing' | 'general'>().notNull(),
  localPart: varchar('local_part', { length: 64 }).notNull(),
  displayName: varchar('display_name', { length: 78 }),
  replyTo: varchar('reply_to', { length: 320 }),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => [
  uniqueIndex('partner_sender_identities_partner_stream_uq').on(t.partnerId, t.stream),
  index('partner_sender_identities_domain_idx').on(t.sendingDomainId)
]);

/**
 * System outbox for provider-side domain releases (spec §3.3). INTENTIONALLY
 * has NO partner_id column: cascadeDeletePartner deletes from every public
 * table that has one, which would erase the provider handle this table exists
 * to keep. Registered in INTENTIONAL_UNSCOPED, forced RLS, system-only policy.
 */
export const emailProviderDomainReleases = pgTable('email_provider_domain_releases', {
  id: uuid('id').primaryKey().defaultRandom(),
  provider: varchar('provider', { length: 20 }).$type<'resend' | 'ses' | 'static' | 'fake'>().notNull(),
  providerDomainId: text('provider_domain_id').notNull(),
  providerRegion: varchar('provider_region', { length: 32 }),
  domain: varchar('domain', { length: 253 }).notNull(),
  reason: varchar('reason', { length: 32 })
    .$type<'user_removed' | 'failed_expired' | 'partner_released' | 'force_release'>()
    .notNull(),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
  lastError: text('last_error')
}, (t) => [
  uniqueIndex('email_provider_domain_releases_provider_domain_uq').on(t.provider, t.providerDomainId),
  index('email_provider_domain_releases_due_idx').on(t.nextAttemptAt)
]);

export type PartnerSendingDomain = typeof partnerSendingDomains.$inferSelect;
export type PartnerSenderIdentity = typeof partnerSenderIdentities.$inferSelect;
export type EmailProviderDomainRelease = typeof emailProviderDomainReleases.$inferSelect;
