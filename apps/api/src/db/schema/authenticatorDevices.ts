import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  index,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { users, bytea } from './users';

export const authenticatorKindEnum = pgEnum('authenticator_kind', [
  'mobile_hw_key',
  'webauthn_platform',
]);

/**
 * WHY a key counts as platform-bound (#1374). Ordered weakest -> strongest, so
 * `enumsortorder` is meaningful in ad-hoc queries.
 *
 * The SERVER-SIDE trusted subset that may reach L4 (critical tier) is
 * `L4_TRUSTED_PLATFORM_BOUND_BASES` in `services/authenticatorAssurance.ts` —
 * not every label here is trusted, and this list is deliberately NOT the gate.
 */
export const authenticatorPlatformBoundBasisEnum = pgEnum('authenticator_platform_bound_basis', [
  // Registered post-#1374 with no attestation presented/verified.
  'unattested',
  // Registered pre-#1374, when is_platform_bound was forced true unconditionally.
  'legacy_unattested',
  // Browser: derived from `singleDevice && !backedUp`. Backup-eligibility
  // flags, NOT a hardware attestation (registration requests attestationType 'none').
  'webauthn_backup_flags',
  // App Attest verified, but the signing key is an RSA Keychain key — NOT
  // Secure Enclave resident (the SE holds only 256-bit EC keys).
  'ios_keychain_rsa_app_attest',
  // App Attest verified AND the signing key is a Secure Enclave P-256 key.
  'ios_se_p256_app_attest',
  // Android Key Attestation verified, keyMintSecurityLevel = TrustedEnvironment.
  'android_tee_key_attestation',
  // Android Key Attestation verified, keyMintSecurityLevel = StrongBox.
  'android_strongbox_key_attestation',
]);

export type PlatformBoundBasis = (typeof authenticatorPlatformBoundBasisEnum.enumValues)[number];

export type AuthenticatorTransport =
  | 'ble' | 'cable' | 'hybrid' | 'internal' | 'nfc' | 'smart-card' | 'usb';

export const authenticatorDevices = pgTable(
  'authenticator_devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    kind: authenticatorKindEnum('kind').notNull(),
    label: varchar('label', { length: 255 }),
    publicKey: text('public_key').notNull(),
    /** Signature algorithm of `publicKey` (#1374 W02). 'RS256' = RSASSA-PKCS1-v1_5
     * + SHA-256 (react-native-biometrics RSA-2048, every pre-W02 row); 'ES256' =
     * ECDSA + SHA-256 over P-256 (Secure Enclave / StrongBox-or-TEE), the only
     * shape an attested platform-bound key can take.
     *
     * READ FROM THIS ROW on every verification — never from the request body.
     * A client-chosen algorithm is an algorithm-confusion vector. The domain is
     * enforced by a DB CHECK; `toMobileKeyAlg` in services/mobileHwKey.ts fails
     * closed on anything else. */
    publicKeyAlg: varchar('public_key_alg', { length: 16 }).notNull().default('RS256'),
    // WebAuthn credential id (web only); null for mobile_hw_key.
    credentialId: text('credential_id').unique(),
    // Anti-clone counter (web) / monotonic nonce counter (mobile).
    signCount: integer('sign_count').notNull().default(0),
    aaguid: varchar('aaguid', { length: 36 }),
    transports: jsonb('transports').$type<AuthenticatorTransport[]>(),
    // DERIVED, NOT ASSERTED. True = non-syncable hardware/platform key. For
    // webauthn_platform this comes from the registration response
    // (singleDevice && !backedUp). For mobile_hw_key it is set only after a
    // verified platform attestation (#1374) — the legacy POST /devices route
    // now registers mobile keys as FALSE.
    //
    // Do NOT gate L4 on this boolean alone — read `platformBoundBasis` too.
    // `L4_TRUSTED_PLATFORM_BOUND_BASES` in services/authenticatorAssurance.ts
    // is the single source of truth for which bases may reach critical tier.
    isPlatformBound: boolean('is_platform_bound').notNull(),
    /** WHY this key counts as platform-bound. See #1374. */
    platformBoundBasis: authenticatorPlatformBoundBasisEnum('platform_bound_basis')
      .notNull()
      .default('unattested'),
    /** When the attestation behind `platformBoundBasis` was VERIFIED server-side.
     * Null for every basis that carries no attestation. */
    attestationVerifiedAt: timestamp('attestation_verified_at', { withTimezone: true }),
    /** Apple App Attest keyId (base64) / Android attestation leaf serial. Not secret. */
    attestationKeyId: text('attestation_key_id'),
    /** SHA-256 of the canonical SPKI DER the attestation actually bound, so an
     * attestation verified for key A can never vouch for a substituted key B. */
    attestedPublicKeySha256: bytea('attested_public_key_sha256'),
    /** NORMALIZED, SERVER-VERIFIED claims only (securityLevel, verifiedBootState,
     * appId, verifier version, evidence digests). Never a raw client blob and
     * never an unverified client assertion. */
    attestationEvidence: jsonb('attestation_evidence').notNull().default({}),
    /** Android Play Integrity verdict time. Null on iOS, where App Attest covers
     * app integrity itself. */
    appIntegrityVerifiedAt: timestamp('app_integrity_verified_at', { withTimezone: true }),
    /** Registration-time proof-of-possession (#1374 W02). Distinct from
     * `lastUsedAt`, which keeps its meaning: null = never used for a real approval. */
    possessionVerifiedAt: timestamp('possession_verified_at', { withTimezone: true }),
    // FK to mobile_devices added in the migration (kept loose here to avoid a
    // schema import cycle); null for webauthn_platform.
    mobileDeviceId: uuid('mobile_device_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    disabledReason: text('disabled_reason'),
  },
  (t) => ({
    userIdx: index('authenticator_devices_user_id_idx').on(t.userId),
  }),
);

export type AuthenticatorDevice = typeof authenticatorDevices.$inferSelect;
export type NewAuthenticatorDevice = typeof authenticatorDevices.$inferInsert;
