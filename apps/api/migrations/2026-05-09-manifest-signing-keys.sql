-- Per-deployment Ed25519 signing key for self-host (BINARY_SOURCE=local)
-- agent update manifests. System-scoped (no tenant column): one active key
-- per deployment, accessed only from the API's system DB context.
--
-- Idempotent.

DO $$ BEGIN
  CREATE TYPE manifest_signing_key_status AS ENUM ('active', 'retired');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS manifest_signing_keys (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id          text NOT NULL UNIQUE,
  public_key_b64  text NOT NULL,
  private_key_enc text NOT NULL,
  status          manifest_signing_key_status NOT NULL DEFAULT 'active',
  created_at      timestamptz NOT NULL DEFAULT now(),
  retired_at      timestamptz
);

CREATE INDEX IF NOT EXISTS idx_manifest_signing_keys_status
  ON manifest_signing_keys(status);

-- Single-active invariant: prevents concurrent ensureActiveSigningKey calls
-- from inserting two 'active' rows on a race.
CREATE UNIQUE INDEX IF NOT EXISTS uq_manifest_signing_keys_active
  ON manifest_signing_keys(status)
  WHERE status = 'active';

-- System-scoped: agent-update infrastructure. Forced RLS gates access so
-- the breeze_app role can read/write only when running under the system
-- DB context (set by withSystemDbAccessContext).
ALTER TABLE manifest_signing_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE manifest_signing_keys FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'manifest_signing_keys'
      AND policyname = 'manifest_signing_keys_system_only'
  ) THEN
    EXECUTE $POLICY$
      CREATE POLICY manifest_signing_keys_system_only
        ON manifest_signing_keys
        USING (current_setting('breeze.scope', true) = 'system')
        WITH CHECK (current_setting('breeze.scope', true) = 'system')
    $POLICY$;
  END IF;
END$$;
