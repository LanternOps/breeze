-- Per-deployment Ed25519 signing key for self-host (BINARY_SOURCE=local)
-- agent update manifests. System-scoped (no tenant column): one key per deployment.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS manifest_signing_keys (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id          text NOT NULL UNIQUE,
  algorithm       text NOT NULL DEFAULT 'ed25519',
  public_key_b64  text NOT NULL,
  private_key_enc text NOT NULL,
  status          text NOT NULL DEFAULT 'active',
  created_at      timestamptz NOT NULL DEFAULT now(),
  retired_at      timestamptz
);

CREATE INDEX IF NOT EXISTS idx_manifest_signing_keys_status
  ON manifest_signing_keys(status);

-- System-scoped: agent-update infrastructure, not tenant-scoped.
-- Forced RLS with no policies — only system context can read/write.
ALTER TABLE manifest_signing_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE manifest_signing_keys FORCE ROW LEVEL SECURITY;
