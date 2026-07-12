-- Platform-operator abuse signals about partners. System-scoped: forced RLS
-- with a system-only policy — partners must never read signals about
-- themselves. All access via withSystemDbAccessContext. Idempotent.

DO $$ BEGIN
  CREATE TYPE abuse_signal_severity AS ENUM ('info', 'watch', 'alert');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS partner_abuse_signals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id      uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  signal_key      varchar(64) NOT NULL,
  severity        abuse_signal_severity NOT NULL,
  score           real NOT NULL DEFAULT 0,
  evidence        jsonb NOT NULL DEFAULT '{}',
  first_fired_at  timestamptz NOT NULL DEFAULT now(),
  computed_at     timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  acknowledged_at timestamptz,
  acknowledged_by varchar(255),
  delivered_at    timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS partner_abuse_signals_open_uq
  ON partner_abuse_signals(partner_id, signal_key)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS partner_abuse_signals_partner_idx
  ON partner_abuse_signals(partner_id);

ALTER TABLE partner_abuse_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_abuse_signals FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'partner_abuse_signals'
      AND policyname = 'partner_abuse_signals_system_only'
  ) THEN
    EXECUTE $POLICY$
      CREATE POLICY partner_abuse_signals_system_only
        ON partner_abuse_signals
        USING (current_setting('breeze.scope', true) = 'system')
        WITH CHECK (current_setting('breeze.scope', true) = 'system')
    $POLICY$;
  END IF;
END$$;
