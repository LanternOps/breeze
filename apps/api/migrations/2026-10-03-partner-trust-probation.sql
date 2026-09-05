-- 2026-10-03-partner-trust-probation.sql
-- Partner trust probation (spec: docs/superpowers/specs/security-auth/2026-09-02-partner-trust-probation-design.md)
-- Idempotent. No inner BEGIN/COMMIT (autoMigrate wraps each file).

DO $$ BEGIN
  CREATE TYPE partner_trust_state AS ENUM ('probation', 'trusted', 'restricted');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE ip_class AS ENUM ('residential', 'business', 'hosting', 'vpn', 'tor', 'unknown');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE partners
  ADD COLUMN IF NOT EXISTS trust_state               partner_trust_state NOT NULL DEFAULT 'trusted',
  ADD COLUMN IF NOT EXISTS trust_changed_at          timestamptz,
  ADD COLUMN IF NOT EXISTS trust_changed_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS trust_reason              text,
  ADD COLUMN IF NOT EXISTS trust_review_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS probation_enrollments     integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS signup_ip_class           ip_class NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS signup_ip_asn             integer,
  ADD COLUMN IF NOT EXISTS signup_ip_classified_at   timestamptz;

CREATE INDEX IF NOT EXISTS partners_trust_state_idx
  ON partners (trust_state) WHERE trust_state <> 'trusted';

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS enrollment_ip_class         ip_class NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS enrollment_ip_asn           integer,
  ADD COLUMN IF NOT EXISTS enrollment_ip_classified_at timestamptz;
