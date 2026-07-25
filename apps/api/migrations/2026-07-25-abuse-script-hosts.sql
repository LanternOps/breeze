-- Script-content abuse detection support tables (rmm.remote_access_installer /
-- rmm.shared_installer_host):
--   * abuse_script_hosts — cross-partner corpus of download hosts extracted
--     from script content and execution stdout. The shared-host correlation
--     intentionally spans ALL partners (including suspended ones), so rows
--     persist independently of partner status.
--   * abuse_sweep_state — tiny key/value scan state (high-water mark for the
--     incremental script_executions stdout scan).
-- Both are system-scoped: forced RLS with a system-only policy — partners
-- must never read the host corpus or scan state (it would reveal what the
-- operator correlates on). All access via withSystemDbAccessContext.
-- Mirrors 2026-07-13-partner-abuse-signals.sql. Idempotent.

DO $$ BEGIN
  CREATE TYPE abuse_script_host_source AS ENUM ('script', 'execution');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS abuse_script_hosts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id    uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  host          varchar(255) NOT NULL,
  source        abuse_script_host_source NOT NULL,
  script_id     uuid REFERENCES scripts(id) ON DELETE SET NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS abuse_script_hosts_partner_host_source_uq
  ON abuse_script_hosts(partner_id, host, source);

CREATE INDEX IF NOT EXISTS abuse_script_hosts_host_idx
  ON abuse_script_hosts(host);

ALTER TABLE abuse_script_hosts ENABLE ROW LEVEL SECURITY;
ALTER TABLE abuse_script_hosts FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'abuse_script_hosts'
      AND policyname = 'abuse_script_hosts_system_only'
  ) THEN
    EXECUTE $POLICY$
      CREATE POLICY abuse_script_hosts_system_only
        ON abuse_script_hosts
        USING (current_setting('breeze.scope', true) = 'system')
        WITH CHECK (current_setting('breeze.scope', true) = 'system')
    $POLICY$;
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS abuse_sweep_state (
  key        varchar(64) PRIMARY KEY,
  value      jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE abuse_sweep_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE abuse_sweep_state FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'abuse_sweep_state'
      AND policyname = 'abuse_sweep_state_system_only'
  ) THEN
    EXECUTE $POLICY$
      CREATE POLICY abuse_sweep_state_system_only
        ON abuse_sweep_state
        USING (current_setting('breeze.scope', true) = 'system')
        WITH CHECK (current_setting('breeze.scope', true) = 'system')
    $POLICY$;
  END IF;
END$$;
