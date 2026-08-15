-- Recidivist-endpoint abuse detection support table (rmm.recidivist_endpoint):
--   * abuse_endpoint_fingerprints — cross-partner corpus of endpoint
--     fingerprints (ScreenConnect remote-tool GUIDs, hostnames, egress IPs)
--     used to correlate the same physical/virtual endpoint re-enrolling under
--     a different partner after a suspension. The correlation intentionally
--     spans ALL partners (including suspended ones), so rows must outlive the
--     device that produced them: device_id is ON DELETE SET NULL (a device
--     hard-delete detaches the row rather than destroying it — see
--     DEVICE_DETACH_DEVICE_ID_TABLES in routes/devices/core.ts) while
--     partner_id is ON DELETE CASCADE, so a partner hard-delete (the GDPR
--     erasure boundary) still removes every fingerprint row that partner
--     contributed.
--   * Retention is indefinite, deliberately: the whole point of this corpus
--     is to catch a partner re-enrolling the same endpoint long after their
--     original suspension, so there is no age-based purge here.
-- System-scoped: forced RLS with a system-only policy — partners must never
-- read the fingerprint corpus (it would reveal what the operator correlates
-- on). All access via withSystemDbAccessContext.
-- Mirrors 2026-07-25-abuse-script-hosts.sql. Idempotent.

DO $$ BEGIN
  CREATE TYPE abuse_endpoint_fingerprint_kind AS ENUM ('remote_tool_guid', 'hostname', 'egress_ip');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS abuse_endpoint_fingerprints (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id    uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  kind          abuse_endpoint_fingerprint_kind NOT NULL,
  value         varchar(255) NOT NULL,
  device_id     uuid REFERENCES devices(id) ON DELETE SET NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS abuse_endpoint_fingerprints_partner_kind_value_uq
  ON abuse_endpoint_fingerprints(partner_id, kind, value);

CREATE INDEX IF NOT EXISTS abuse_endpoint_fingerprints_kind_value_idx
  ON abuse_endpoint_fingerprints(kind, value);

ALTER TABLE abuse_endpoint_fingerprints ENABLE ROW LEVEL SECURITY;
ALTER TABLE abuse_endpoint_fingerprints FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'abuse_endpoint_fingerprints'
      AND policyname = 'abuse_endpoint_fingerprints_system_only'
  ) THEN
    EXECUTE $POLICY$
      CREATE POLICY abuse_endpoint_fingerprints_system_only
        ON abuse_endpoint_fingerprints
        USING (current_setting('breeze.scope', true) = 'system')
        WITH CHECK (current_setting('breeze.scope', true) = 'system')
    $POLICY$;
  END IF;
END$$;
