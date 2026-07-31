import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  uniqueIndex,
  pgEnum,
  bigint,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const manifestSigningKeyStatus = pgEnum('manifest_signing_key_status', [
  'active',
  'retired',
]);

export const manifestSigningKeys = pgTable(
  'manifest_signing_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    keyId: text('key_id').notNull().unique(),
    publicKeyB64: text('public_key_b64').notNull(),
    privateKeyEnc: text('private_key_enc').notNull(),
    status: manifestSigningKeyStatus('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
  },
  (t) => ({
    statusIdx: index('idx_manifest_signing_keys_status').on(t.status),
    // Single-active invariant: only one 'active' row allowed per deployment.
    // The partial unique index lives in the migration; this declaration is for
    // drift detection only.
    activeUnique: uniqueIndex('uq_manifest_signing_keys_active')
      .on(t.status)
      .where(sql`${t.status} = 'active'`),
  }),
);

/**
 * Signed, monotonic, time-bounded authorisation to add ONE previously unseen
 * manifest signing key to an agent's frozen trust set (Wave 6 Task 7).
 *
 * Wave 6 Task 6 froze trust-on-first-use: once an agent has pinned its one
 * deployment key, ANY unseen key delivered over the wire is rejected
 * (ErrManifestTrustExpansionRejected). A row here — signed by the key that is
 * ALREADY trusted — is the only thing that can unfreeze it. A control plane
 * with database write access but no signing key cannot forge one.
 *
 * System-scoped, like `manifest_signing_keys`: no tenant column, forced RLS,
 * and a single system-only policy. Registered in INTENTIONAL_UNSCOPED. It has
 * no `org_id`, so it needs NO cascade-list registration.
 */
export const manifestSigningKeyDelegations = pgTable(
  'manifest_signing_key_delegations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Monotonic replay counter. UNIQUE makes epoch reuse impossible at the
    // storage layer, not just in the rotation CLI's pre-checks. The agent
    // additionally requires epoch > its own persisted epoch, so an epoch that
    // has already been adopted can never be replayed against it.
    epoch: bigint('epoch', { mode: 'number' }).notNull().unique(),
    oldKeyId: text('old_key_id').notNull(),
    newKeyId: text('new_key_id').notNull(),
    newPublicKeyB64: text('new_public_key_b64').notNull(),
    notBefore: timestamp('not_before', { withTimezone: true }).notNull(),
    notAfter: timestamp('not_after', { withTimezone: true }).notNull(),
    // Ed25519 signature over the canonical delegation bytes (see
    // services/manifestSigning.ts manifestDelegationCanonicalBytes). Signed by
    // old_key_id's private key. Never logged.
    signatureB64: text('signature_b64').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // Set when the operator runs `activate` — i.e. when the new key actually
    // becomes the deployment's signing key. `prepare` leaves this NULL, which
    // is what "prepared but not activated" means.
    activatedAt: timestamp('activated_at', { withTimezone: true }),
  },
  (t) => ({
    // Declared for drift detection; the constraint itself lives in the
    // migration.
    windowChk: check(
      'manifest_signing_key_delegations_window_chk',
      sql`${t.notAfter} > ${t.notBefore}`,
    ),
    activeWindowIdx: index('idx_manifest_signing_key_delegations_window').on(
      t.notBefore,
      t.notAfter,
    ),
  }),
);
