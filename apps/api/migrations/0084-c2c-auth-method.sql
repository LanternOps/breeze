-- Add auth_method column to c2c_connections (platform_app vs manual)
ALTER TABLE "c2c_connections"
  ADD COLUMN IF NOT EXISTS "auth_method" varchar(20) NOT NULL DEFAULT 'manual';

-- Constrain auth_method values at the DB level
DO $$ BEGIN
  ALTER TABLE "c2c_connections"
    ADD CONSTRAINT c2c_connections_auth_method_check
    CHECK (auth_method IN ('platform_app', 'manual'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Consent session state for C2C OAuth admin consent flows
CREATE TABLE IF NOT EXISTS "c2c_consent_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "state" varchar(64) NOT NULL UNIQUE,
  "provider" varchar(30) NOT NULL DEFAULT 'microsoft_365',
  "display_name" varchar(200),
  "scopes" text,
  "redirect_url" varchar(500),
  "expires_at" timestamp NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
