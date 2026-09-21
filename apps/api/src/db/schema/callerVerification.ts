/**
 * Caller verification (anti-vishing) — W01 backend core (#6354 / #6355).
 *
 * Spec: docs/superpowers/specs/security-auth/2026-09-18-caller-verification-design.md
 *
 * Four tenant tables:
 *  - caller_verification_subject_bindings  (shape 1, org_id)  canonical directory / OS identity ↔ contact
 *  - caller_verification_destinations      (shape 1, org_id)  hashed email/mobile provenance history
 *  - caller_verifications                  (shape 1, org_id)  durable verification work records
 *  - caller_verification_policies          (dual-axis, org XOR partner) inherited policy floors
 *
 * SQL is authoritative for `DEFERRABLE INITIALLY IMMEDIATE` and the
 * column-specific `ON DELETE SET NULL (col)` clauses (migration
 * 2026-10-26-140000); Drizzle cannot express either, so the FK declarations
 * below mirror columns/targets only. Never add single-column FKs in place of
 * the composites — ownership (contact_id, org_id) is part of every reference.
 *
 * No `device_id` / `ticket_id` columns by design: `workstation_device_ref`,
 * `ticket_ref` and `consumed_intent_ref` are FK-less snapshots so the row
 * survives device/ticket/intent deletion and never joins the device or ticket
 * cascade walkers.
 */
import { sql } from 'drizzle-orm';
import {
  pgTable, pgEnum, uuid, varchar, char, text, timestamp, smallint, integer, boolean, inet,
  foreignKey, unique, uniqueIndex, index, check,
} from 'drizzle-orm/pg-core';
import { contacts } from './contacts';
import { organizations, partners } from './orgs';
import { users } from './users';
import { deviceCommands } from './devices';

export const callerVerificationMethodEnum = pgEnum('caller_verification_method', [
  'workstation', 'sms', 'email', 'callback_attestation', 'administrative_stepup',
]);
export const callerVerificationStatusEnum = pgEnum('caller_verification_status', [
  'pending', 'verified', 'rejected_by_user', 'wrong_choice', 'expired', 'undeliverable', 'cancelled', 'revoked',
]);
export const callerVerificationActionScopeEnum = pgEnum('caller_verification_action_scope', [
  'reset_password', 'disable_user', 'any',
]);
export const callerVerificationBindingSourceEnum = pgEnum('caller_verification_binding_source', [
  'directory_sync', 'technician_attested', 'observed_login',
]);
export const callerVerificationDestinationKindEnum = pgEnum('caller_verification_destination_kind', [
  'email', 'mobile',
]);
export const callerVerificationDestinationSourceEnum = pgEnum('caller_verification_destination_source', [
  'technician', 'import', 'inbound_email', 'ai_tool', 'portal_self_service',
]);

const time = (name: string) => timestamp(name, { withTimezone: true });

export const callerVerificationSubjectBindings = pgTable('caller_verification_subject_bindings', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  contactId: uuid('contact_id').notNull(),
  entraTenantId: varchar('entra_tenant_id', { length: 64 }),
  entraOid: varchar('entra_oid', { length: 64 }),
  upnSnapshot: varchar('upn_snapshot', { length: 320 }),
  osPrincipal: varchar('os_principal', { length: 255 }),
  osUsername: varchar('os_username', { length: 255 }),
  source: callerVerificationBindingSourceEnum('source').notNull(),
  establishedAt: time('established_at').notNull().defaultNow(),
  attestedByUserId: uuid('attested_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  attestedAt: time('attested_at'),
  revokedAt: time('revoked_at'),
  createdAt: time('created_at').notNull().defaultNow(),
  updatedAt: time('updated_at').notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: 'cv_bindings_contact_org_fk', columns: [t.contactId, t.orgId], foreignColumns: [contacts.id, contacts.orgId] }).onDelete('cascade'),
  unique('cv_bindings_id_org_uq').on(t.id, t.orgId),
  unique('cv_bindings_id_contact_org_uq').on(t.id, t.contactId, t.orgId),
  uniqueIndex('cv_bindings_entra_active_uq').on(t.orgId, t.entraTenantId, t.entraOid).where(sql`${t.revokedAt} IS NULL`),
  uniqueIndex('cv_bindings_os_active_uq').on(t.orgId, t.osPrincipal).where(sql`${t.revokedAt} IS NULL`),
  index('cv_bindings_contact_idx').on(t.orgId, t.contactId),
  check('cv_bindings_entra_pair_chk', sql`(${t.entraTenantId} IS NULL) = (${t.entraOid} IS NULL)`),
  check('cv_bindings_identity_chk', sql`${t.entraOid} IS NOT NULL OR ${t.osPrincipal} IS NOT NULL`),
]);

export const callerVerificationDestinations = pgTable('caller_verification_destinations', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  contactId: uuid('contact_id').notNull(),
  kind: callerVerificationDestinationKindEnum('kind').notNull(),
  valueHash: char('value_hash', { length: 64 }).notNull(),
  valueRedacted: varchar('value_redacted', { length: 64 }).notNull(),
  setAt: time('set_at').notNull().defaultNow(),
  supersededAt: time('superseded_at'),
  setByUserId: uuid('set_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  source: callerVerificationDestinationSourceEnum('source').notNull(),
  attestedByUserId: uuid('attested_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  attestedAt: time('attested_at'),
}, (t) => [
  foreignKey({ name: 'cv_destinations_contact_org_fk', columns: [t.contactId, t.orgId], foreignColumns: [contacts.id, contacts.orgId] }).onDelete('cascade'),
  unique('cv_destinations_id_org_uq').on(t.id, t.orgId),
  unique('cv_destinations_id_contact_org_uq').on(t.id, t.contactId, t.orgId),
  uniqueIndex('cv_destinations_current_uq').on(t.contactId, t.kind).where(sql`${t.supersededAt} IS NULL`),
]);

export const callerVerifications = pgTable('caller_verifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  contactId: uuid('contact_id').notNull(),
  requesterBindingId: uuid('requester_binding_id'),
  targetBindingId: uuid('target_binding_id'),
  targetEntraTenantId: varchar('target_entra_tenant_id', { length: 64 }),
  targetEntraOid: varchar('target_entra_oid', { length: 64 }),
  initiatedByUserId: uuid('initiated_by_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  technicianLabel: varchar('technician_label', { length: 255 }).notNull(),
  actionScope: callerVerificationActionScopeEnum('action_scope').notNull(),
  targetLabel: varchar('target_label', { length: 320 }),
  method: callerVerificationMethodEnum('method').notNull(),
  reason: text('reason'),
  stepupSessionId: text('stepup_session_id'),
  stepupAuthEpoch: integer('stepup_auth_epoch'),
  stepupMfaEpoch: integer('stepup_mfa_epoch'),
  stepupVerifiedAt: time('stepup_verified_at'),
  status: callerVerificationStatusEnum('status').notNull().default('pending'),
  tier: smallint('tier').notNull(),
  tierReason: varchar('tier_reason', { length: 64 }).notNull(),
  matchValue: char('match_value', { length: 2 }).notNull(),
  decoyValues: char('decoy_values', { length: 2 }).array().notNull(),
  reverseCode: char('reverse_code', { length: 4 }).notNull(),
  challengeTokenHash: char('challenge_token_hash', { length: 64 }),
  destinationId: uuid('destination_id'),
  destinationRedacted: varchar('destination_redacted', { length: 64 }),
  workstationDeviceRef: uuid('workstation_device_ref'),
  deviceHostname: varchar('device_hostname', { length: 255 }),
  osUsername: varchar('os_username', { length: 255 }),
  osPrincipalObserved: varchar('os_principal_observed', { length: 255 }),
  agentCommandId: uuid('agent_command_id').references(() => deviceCommands.id, { onDelete: 'set null' }),
  ticketRef: uuid('ticket_ref'),
  ticketNumber: varchar('ticket_number', { length: 32 }),
  attemptNo: smallint('attempt_no').notNull(),
  expiresAt: time('expires_at').notNull(),
  decidedAt: time('decided_at'),
  decidedFromIp: inet('decided_from_ip'),
  consumedIntentRef: uuid('consumed_intent_ref'),
  consumedAt: time('consumed_at'),
  attestationNote: text('attestation_note'),
  fenceOverrideUntil: time('fence_override_until'),
  deliveryPublishedAt: time('delivery_published_at'),
  rejectionNotifiedAt: time('rejection_notified_at'),
  createdAt: time('created_at').notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: 'cv_contact_org_fk', columns: [t.contactId, t.orgId], foreignColumns: [contacts.id, contacts.orgId] }).onDelete('cascade'),
  foreignKey({
    name: 'cv_requester_fk',
    columns: [t.requesterBindingId, t.contactId, t.orgId],
    foreignColumns: [callerVerificationSubjectBindings.id, callerVerificationSubjectBindings.contactId, callerVerificationSubjectBindings.orgId],
  }).onDelete('set null'),
  foreignKey({
    name: 'cv_target_fk',
    columns: [t.targetBindingId, t.orgId],
    foreignColumns: [callerVerificationSubjectBindings.id, callerVerificationSubjectBindings.orgId],
  }).onDelete('set null'),
  foreignKey({
    name: 'cv_destination_fk',
    columns: [t.destinationId, t.contactId, t.orgId],
    foreignColumns: [callerVerificationDestinations.id, callerVerificationDestinations.contactId, callerVerificationDestinations.orgId],
  }).onDelete('set null'),
  unique('cv_id_org_uq').on(t.id, t.orgId),
  unique('cv_id_contact_org_uq').on(t.id, t.contactId, t.orgId),
  index('cv_contact_history_idx').on(t.orgId, t.contactId, t.createdAt.desc()),
  index('cv_target_idx').on(t.orgId, t.targetBindingId, t.createdAt.desc()),
  uniqueIndex('cv_token_uq').on(t.challengeTokenHash).where(sql`${t.challengeTokenHash} IS NOT NULL`),
  uniqueIndex('cv_command_uq').on(t.agentCommandId).where(sql`${t.agentCommandId} IS NOT NULL`),
  index('cv_gate_idx').on(t.contactId, t.status, t.consumedAt).where(sql`${t.status}='verified' AND ${t.consumedAt} IS NULL`),
  index('cv_requester_binding_idx').on(t.requesterBindingId).where(sql`${t.requesterBindingId} IS NOT NULL`),
  index('cv_destination_idx').on(t.destinationId).where(sql`${t.destinationId} IS NOT NULL`),
  index('cv_initiated_by_idx').on(t.initiatedByUserId),
  check('cv_tier_chk', sql`${t.tier} BETWEEN 0 AND 3`),
  check('cv_attempt_chk', sql`${t.attemptNo} > 0`),
  check('cv_choices_chk', sql`${t.matchValue} ~ '^[0-9]{2}$' AND cardinality(${t.decoyValues})=2 AND array_position(${t.decoyValues},NULL) IS NULL AND ${t.decoyValues}[1] ~ '^[0-9]{2}$' AND ${t.decoyValues}[2] ~ '^[0-9]{2}$' AND ${t.matchValue} <> ALL(${t.decoyValues}) AND ${t.decoyValues}[1] <> ${t.decoyValues}[2] AND ${t.reverseCode} ~ '^[0-9]{4}$'`),
  check('cv_admin_chk', sql`${t.method} <> 'administrative_stepup' OR (${t.actionScope}='disable_user' AND ${t.reason} IS NOT NULL AND length(btrim(${t.reason})) >= 20 AND ${t.stepupSessionId} IS NOT NULL AND ${t.stepupAuthEpoch} IS NOT NULL AND ${t.stepupMfaEpoch} IS NOT NULL AND ${t.stepupVerifiedAt} IS NOT NULL)`),
]);

/**
 * Dual-ownership policy (Partner-Wide First, #2135): org_id XOR partner_id.
 * Every field is nullable — NULL inherits (partner baseline → code defaults).
 */
export const callerVerificationPolicies = pgTable('caller_verification_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id),
  partnerId: uuid('partner_id').references(() => partners.id),
  requiredTierResetPassword: smallint('required_tier_reset_password'),
  requiredTierDisableUser: smallint('required_tier_disable_user'),
  disableUserAuthorizerRoles: text('disable_user_authorizer_roles').array(),
  verificationTtlMinutes: integer('verification_ttl_minutes'),
  allowedMethods: text('allowed_methods').array(),
  workstationTimeoutSeconds: integer('workstation_timeout_seconds'),
  destinationMinAgeDays: integer('destination_min_age_days'),
  requireAttestedDestination: boolean('require_attested_destination'),
  requireTicket: boolean('require_ticket'),
  allowCrossTechnicianUse: boolean('allow_cross_technician_use'),
  allowAdministrativeDisable: boolean('allow_administrative_disable'),
  maxAttemptsPerHour: smallint('max_attempts_per_hour'),
  coolingOffHours: integer('cooling_off_hours'),
  createdAt: time('created_at').notNull().defaultNow(),
  updatedAt: time('updated_at').notNull().defaultNow(),
  updatedByUserId: uuid('updated_by_user_id').references(() => users.id, { onDelete: 'set null' }),
}, (t) => [
  unique('cv_policy_org_uq').on(t.orgId),
  unique('cv_policy_partner_uq').on(t.partnerId),
  index('cv_policy_updated_by_idx').on(t.updatedByUserId),
  check('caller_verification_policies_one_owner_chk', sql`(${t.orgId} IS NULL) <> (${t.partnerId} IS NULL)`),
  check('cv_policy_reset_tier_chk', sql`${t.requiredTierResetPassword} BETWEEN 0 AND 3`),
  check('cv_policy_disable_tier_chk', sql`${t.requiredTierDisableUser} BETWEEN 0 AND 3`),
  check('cv_policy_ttl_chk', sql`${t.verificationTtlMinutes} BETWEEN 5 AND 240`),
  check('cv_policy_timeout_chk', sql`${t.workstationTimeoutSeconds} BETWEEN 30 AND 300`),
  check('cv_policy_age_chk', sql`${t.destinationMinAgeDays} BETWEEN 0 AND 90`),
  check('cv_policy_attempts_chk', sql`${t.maxAttemptsPerHour} BETWEEN 1 AND 100`),
  check('cv_policy_cooling_chk', sql`${t.coolingOffHours} BETWEEN 1 AND 720`),
  check('cv_policy_methods_chk', sql`${t.allowedMethods} <@ ARRAY['workstation','sms','email','callback_attestation']::text[]`),
]);

export type BindingRow = typeof callerVerificationSubjectBindings.$inferSelect;
export type DestinationRow = typeof callerVerificationDestinations.$inferSelect;
export type PolicyRow = typeof callerVerificationPolicies.$inferSelect;
export type VerificationRow = typeof callerVerifications.$inferSelect;
