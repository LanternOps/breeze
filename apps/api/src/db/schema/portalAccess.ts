import { pgTable, uuid, boolean, text, integer, timestamp, check, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, partners } from './orgs';
import { users } from './users';

/**
 * Portal registration W3 (#11380): portal access policy and access-request queue.
 * Spec: docs/superpowers/specs/portal/2026-11-07-portal-registration-options-design.md §4, §5.1, §5.3.
 * Migration: 2027-01-22-232800-portal-access-policies-requests.sql.
 */

export type PortalPasswordMode = 'allowed' | 'sso_only';
export type PortalSelfRegistrationMode = 'off' | 'approval' | 'instant';
export type PortalSsoNewPersonMode = 'invited_only' | 'approval' | 'instant';
export type PortalAccessRequestSource = 'self' | 'entra' | 'google' | 'addin_user';
export type PortalAccessRequestStatus = 'pending' | 'approved' | 'denied' | 'expired';

/**
 * Dual-axis policy (org override XOR partner default, #2135). A NULL column
 * means inherit (org row) or the built-in default (partner row). RLS: FOR ALL
 * org-or-partner, plus two SELECT-only branches that let a partner context and
 * an org-scoped context (portal sessions, org tokens) read the partner default
 * (plan D7). Read ONLY through resolvePortalAccessPolicy
 * (services/portalAccessPolicy.ts).
 */
export const portalAccessPolicies = pgTable('portal_access_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id),
  partnerId: uuid('partner_id').references(() => partners.id),
  entraEnabled: boolean('entra_enabled'),
  googleEnabled: boolean('google_enabled'),
  passwordMode: text('password_mode').$type<PortalPasswordMode>(),
  selfRegistrationMode: text('self_registration_mode').$type<PortalSelfRegistrationMode>(),
  ssoNewPersonMode: text('sso_new_person_mode').$type<PortalSsoNewPersonMode>(),
  ssoSessionMaxHours: integer('sso_session_max_hours'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('portal_access_policies_one_owner_chk', sql`(${t.orgId} IS NULL) <> (${t.partnerId} IS NULL)`),
  uniqueIndex('portal_access_policies_partner_uq').on(t.partnerId).where(sql`${t.partnerId} IS NOT NULL`),
  uniqueIndex('portal_access_policies_org_uq').on(t.orgId).where(sql`${t.orgId} IS NOT NULL`),
]);

/**
 * One person's request for browser portal access to one org (tenancy shape 1).
 * `org_id NOT NULL` by design: a request is queue data for one org's portal,
 * not configuration, so the partner-wide-first rule does not apply (plan D9).
 *
 * SQL-only (same convention as `portal_user_identities_user_org_fk`): the
 * composite FK `portal_access_requests_user_org_fk` (portal_user_id, org_id) →
 * portal_users (id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
 * and the source / status / email / claims / decision CHECKs.
 *
 * At most one pending row per (org_id, email) — the partial unique index
 * below. Expiry is lazy: a pending row past `expires_at` reads as expired.
 */
export const portalAccessRequests = pgTable('portal_access_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  portalUserId: uuid('portal_user_id'),
  // lower(btrim(email)), enforced by portal_access_requests_email_chk.
  email: text('email').notNull(),
  name: text('name'),
  source: text('source').$type<PortalAccessRequestSource>().notNull(),
  // Entra: https://login.microsoftonline.com/{tid}/v2.0 ; Google: https://accounts.google.com
  issuer: text('issuer'),
  // Entra oid ; Google sub
  subject: text('subject'),
  entraTenantId: text('entra_tenant_id'),
  status: text('status').$type<PortalAccessRequestStatus>().notNull().default('pending'),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  lastRequestedAt: timestamp('last_requested_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decidedByUserId: uuid('decided_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('portal_access_requests_pending_email_uq').on(t.orgId, t.email).where(sql`${t.status} = 'pending'`),
  index('portal_access_requests_org_status_idx').on(t.orgId, t.status, t.requestedAt.desc()),
  index('portal_access_requests_portal_user_idx').on(t.portalUserId).where(sql`${t.portalUserId} IS NOT NULL`),
]);

export type PortalAccessPolicyRow = typeof portalAccessPolicies.$inferSelect;
export type PortalAccessRequestRow = typeof portalAccessRequests.$inferSelect;
