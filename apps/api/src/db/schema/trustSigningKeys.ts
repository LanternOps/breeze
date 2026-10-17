import { pgTable, uuid, text, timestamp, jsonb, uniqueIndex, pgEnum, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Per-deployment ES256 keyset for Trust Center attestations (W3b, #8771).
 *
 * System-scoped like `manifest_signing_keys`: no tenant column, forced RLS and
 * a single system-only policy (migration 2026-12-30-110500). Registered in
 * rls-coverage INTENTIONAL_UNSCOPED. No `org_id`, so no cascade, merge or
 * export registration applies.
 */
export const trustSigningKeyStatus = pgEnum('trust_signing_key_status', [
  'pending',
  'active',
  'verify_only',
  'revoked',
]);

export const trustSigningKeys = pgTable(
  'trust_signing_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kid: text('kid').notNull().unique(),
    alg: text('alg').notNull().default('ES256'),
    /** Public JWK only ({kty, crv, x, y}); never private fields. */
    publicJwk: jsonb('public_jwk').notNull(),
    /** Private JWK, encrypted with AAD `trust_signing_keys.private_key_enc`. NULL once verify_only/revoked. */
    privateKeyEnc: text('private_key_enc'),
    status: trustSigningKeyStatus('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => ({
    // Declared for drift detection; the constraints live in the migration.
    algChk: check('trust_signing_keys_alg_chk', sql`${t.alg} = 'ES256'`),
    privateKeyChk: check(
      'trust_signing_keys_private_key_chk',
      sql`${t.status} IN ('verify_only', 'revoked') OR ${t.privateKeyEnc} IS NOT NULL`,
    ),
    oneActive: uniqueIndex('trust_signing_keys_one_active_uq')
      .on(t.status)
      .where(sql`${t.status} = 'active'`),
  }),
);
