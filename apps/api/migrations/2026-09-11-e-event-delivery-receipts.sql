-- Wave 3.5c (#4085): durable delivery receipts, keyed (event_id, subscriber_id).
-- Tenancy shape 1 (direct org_id). Written ONLY under system DB context by the
-- event-dispatch worker; org policies exist for the RLS contract + GDPR erasure.
-- status: planned -> delivering -> delivered | failed. 'delivering' found on a
-- retry means a crash mid-handler: outcome unknown, re-claimed (at-least-once).
CREATE TABLE IF NOT EXISTS event_delivery_receipts (
  event_id varchar(100) NOT NULL,
  subscriber_id varchar(50) NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id),
  event_type varchar(100) NOT NULL,
  mode varchar(10) NOT NULL,               -- 'shadow' | 'enforce'
  status varchar(12) NOT NULL DEFAULT 'planned',
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  delivered_at timestamp,
  PRIMARY KEY (event_id, subscriber_id)
);

CREATE INDEX IF NOT EXISTS event_delivery_receipts_org_idx ON event_delivery_receipts (org_id);
-- Retention scans delete by age + terminal status; partial keeps it cheap.
CREATE INDEX IF NOT EXISTS event_delivery_receipts_retention_idx
  ON event_delivery_receipts (created_at)
  WHERE status IN ('delivered', 'failed');
-- Shadow comparison + drift metrics scan recent rows by mode.
CREATE INDEX IF NOT EXISTS event_delivery_receipts_mode_created_idx
  ON event_delivery_receipts (mode, created_at);

ALTER TABLE event_delivery_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_delivery_receipts FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'event_delivery_receipts' AND policyname = 'breeze_org_isolation_select') THEN
    EXECUTE $POLICY$ CREATE POLICY breeze_org_isolation_select ON event_delivery_receipts FOR SELECT USING (public.breeze_has_org_access(org_id)) $POLICY$;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'event_delivery_receipts' AND policyname = 'breeze_org_isolation_insert') THEN
    EXECUTE $POLICY$ CREATE POLICY breeze_org_isolation_insert ON event_delivery_receipts FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id)) $POLICY$;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'event_delivery_receipts' AND policyname = 'breeze_org_isolation_update') THEN
    EXECUTE $POLICY$ CREATE POLICY breeze_org_isolation_update ON event_delivery_receipts FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id)) $POLICY$;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'event_delivery_receipts' AND policyname = 'breeze_org_isolation_delete') THEN
    EXECUTE $POLICY$ CREATE POLICY breeze_org_isolation_delete ON event_delivery_receipts FOR DELETE USING (public.breeze_has_org_access(org_id)) $POLICY$;
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON event_delivery_receipts TO breeze_app;
