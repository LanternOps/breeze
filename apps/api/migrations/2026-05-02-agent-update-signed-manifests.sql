-- Add offline-signed release manifest metadata for agent update trust roots.
ALTER TABLE "agent_versions"
  ADD COLUMN IF NOT EXISTS "release_manifest" text,
  ADD COLUMN IF NOT EXISTS "manifest_signature" text,
  ADD COLUMN IF NOT EXISTS "signing_key_id" varchar(128);
