-- Phase 2 of per-partner LLM BYOK (#3922): platform-maintained catalog of
-- vetted Anthropic-compatible endpoints. Revisions are IMMUTABLE — routing a
-- partner's key to a new URL always means a new revision + fresh verification.
-- System-wide (no org_id); writes gated to platform-admin role + MFA at the
-- route layer, mirroring third_party_package_catalog's posture (no RLS).

CREATE TABLE IF NOT EXISTS llm_provider_catalog (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug               text NOT NULL,
  name               text NOT NULL,
  status             text NOT NULL DEFAULT 'draft',
  active_revision_id uuid,
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT llm_provider_catalog_slug_uq UNIQUE (slug),
  CONSTRAINT llm_provider_catalog_status_chk CHECK (status IN ('draft', 'listed', 'delisted'))
);

CREATE TABLE IF NOT EXISTS llm_provider_catalog_revisions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_entry_id uuid NOT NULL REFERENCES llm_provider_catalog(id) ON DELETE CASCADE,
  revision         integer NOT NULL,
  base_url         text NOT NULL,
  auth_mode        text NOT NULL,
  model_map        jsonb NOT NULL,
  data_note        text,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT llm_provider_catalog_revisions_uq UNIQUE (catalog_entry_id, revision),
  CONSTRAINT llm_provider_catalog_revisions_auth_chk CHECK (auth_mode IN ('x-api-key', 'bearer')),
  CONSTRAINT llm_provider_catalog_revisions_url_chk CHECK (base_url ~ '^https://')
);

DO $$ BEGIN
  ALTER TABLE llm_provider_catalog
    ADD CONSTRAINT llm_provider_catalog_active_rev_fk
    FOREIGN KEY (active_revision_id) REFERENCES llm_provider_catalog_revisions(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS llm_provider_verifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revision_id     uuid NOT NULL REFERENCES llm_provider_catalog_revisions(id) ON DELETE CASCADE,
  model_id        text NOT NULL,
  harness_version text NOT NULL,
  passed          boolean NOT NULL,
  detail          jsonb,
  verified_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS llm_provider_verifications_rev_idx
  ON llm_provider_verifications(revision_id, model_id, created_at DESC);

-- Immutability: revisions can be inserted and cascade-deleted, never updated.
CREATE OR REPLACE FUNCTION llm_provider_catalog_revisions_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'llm_provider_catalog_revisions rows are immutable — create a new revision';
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS llm_provider_catalog_revisions_no_update ON llm_provider_catalog_revisions;
CREATE TRIGGER llm_provider_catalog_revisions_no_update
  BEFORE UPDATE ON llm_provider_catalog_revisions
  FOR EACH ROW EXECUTE FUNCTION llm_provider_catalog_revisions_immutable();
