-- Trust Center W3b (#8771): per-deployment ES256 signing keyset for public
-- trust-page attestations (a compact JWT over the published payload, verified
-- against /api/v1/trust/attestation/jwks.json).
--
-- System-scoped (no tenant column): one signer per deployment, accessed only
-- from the API's system DB context. Mirrors manifest_signing_keys.
--
-- Lifecycle: pending (published in the JWKS, not signing) → active (signs) →
-- verify_only (published, private key destroyed) → revoked (removed from the
-- JWKS, private key destroyed). private_key_enc is the private JWK encrypted
-- with secretCrypto (AAD trust_signing_keys.private_key_enc).
--
-- Idempotent. DDL only.

DO $$ BEGIN
  CREATE TYPE trust_signing_key_status AS ENUM ('pending', 'active', 'verify_only', 'revoked');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS trust_signing_keys (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kid             text NOT NULL UNIQUE,
  alg             text NOT NULL DEFAULT 'ES256',
  public_jwk      jsonb NOT NULL,
  private_key_enc text NULL,
  status          trust_signing_key_status NOT NULL DEFAULT 'pending',
  created_at      timestamptz NOT NULL DEFAULT now(),
  activated_at    timestamptz,
  retired_at      timestamptz,
  revoked_at      timestamptz,
  CONSTRAINT trust_signing_keys_alg_chk CHECK (alg = 'ES256'),
  -- A key that can still sign (pending, active) must hold its private key;
  -- verify_only and revoked keys have it destroyed.
  CONSTRAINT trust_signing_keys_private_key_chk
    CHECK (status IN ('verify_only', 'revoked') OR private_key_enc IS NOT NULL)
);

-- Single-active invariant: concurrent first-use provisioning on two API
-- instances cannot leave two signing keys.
CREATE UNIQUE INDEX IF NOT EXISTS trust_signing_keys_one_active_uq
  ON trust_signing_keys(status)
  WHERE status = 'active';

-- Forced RLS with a single system-only policy: the breeze_app role can read
-- or write only under the system DB context (withSystemDbAccessContext).
ALTER TABLE trust_signing_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE trust_signing_keys FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'trust_signing_keys'
      AND policyname = 'trust_signing_keys_system_only'
  ) THEN
    EXECUTE $POLICY$
      CREATE POLICY trust_signing_keys_system_only
        ON trust_signing_keys
        USING (current_setting('breeze.scope', true) = 'system')
        WITH CHECK (current_setting('breeze.scope', true) = 'system')
    $POLICY$;
  END IF;
END$$;
