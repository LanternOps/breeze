import { pgTable, uuid, integer, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './users';
import { partners } from './orgs';
import { sql } from 'drizzle-orm';

// Entra identity → Breeze technician binding for the Office add-in tech
// persona (spec §2.2). Tenancy: shape 3 partner-axis (no org_id → no
// cascade/export registration). The binding is MFA-established
// (mfa_verified_at) and is the ONLY path from an Entra identity to a
// Breeze user — email is never an authorization identifier.
// bound_auth_epoch + bound_mfa_epoch snapshot both live user generations at
// bind time. Password/status changes and every factor lifecycle change thus
// invalidate the durable Entra binding independently of Redis session cleanup.
export const officeAddinUserBindings = pgTable('office_addin_user_bindings', {
  id: uuid('id').primaryKey().defaultRandom(),
  entraTenantId: uuid('entra_tenant_id').notNull(),
  entraOid: uuid('entra_oid').notNull(),
  userId: uuid('user_id').notNull().references(() => users.id),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  boundAuthEpoch: integer('bound_auth_epoch').notNull(),
  // DEFAULT 0 is a DB-level safety net only: an old API replica mid-rollout
  // (rolling deploy, or an image rollback) that inserts without this column
  // still succeeds instead of raising a NOT NULL violation. The app always
  // supplies a real epoch (>= 1) on every insert; 0 never matches a live
  // users.mfa_epoch, so a binding stuck at the sentinel fails closed in
  // vetBinding exactly as a NULL would have.
  boundMfaEpoch: integer('bound_mfa_epoch').notNull().default(0),
  mfaVerifiedAt: timestamp('mfa_verified_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedBy: uuid('revoked_by').references(() => users.id),
}, (t) => [
  uniqueIndex('office_addin_bindings_identity_active_uq')
    .on(t.entraTenantId, t.entraOid).where(sql`revoked_at IS NULL`),
  uniqueIndex('office_addin_bindings_user_active_uq')
    .on(t.userId).where(sql`revoked_at IS NULL`),
]);
