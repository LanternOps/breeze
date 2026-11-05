-- #10531 W1-C: webhooks belong to exactly one organization OR partner.
-- OD1: partner URLs, secrets, headers and cross-org history are partner-private;
-- deliberately no partner-wide SELECT branch for organization sessions.
-- Delivery org_id records the EVENT organization for erasure/merge/export;
-- read authority stays with the parent webhook. A SECURITY DEFINER insert
-- trigger validates the event owner past RLS and fills legacy org-webhook inserts.
-- Test-id marker deviation: route tests may use any subscribed event type and
-- AI tests use 'test', so NULL org_id is allowed by event_id LIKE 'test-%',
-- not by event_type = 'webhook.test'. This migration writes no rows.

ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES partners(id);
ALTER TABLE webhooks ALTER COLUMN org_id DROP NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conname = 'webhooks_one_owner_chk' AND conrelid = 'webhooks'::regclass) THEN
    ALTER TABLE webhooks ADD CONSTRAINT webhooks_one_owner_chk
      CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS webhooks_partner_active_idx ON webhooks (partner_id) WHERE status = 'active';

ALTER TABLE webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhooks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON webhooks;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON webhooks;
DROP POLICY IF EXISTS breeze_org_isolation_update ON webhooks;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON webhooks;
DROP POLICY IF EXISTS webhooks_isolation ON webhooks;
CREATE POLICY webhooks_isolation ON webhooks FOR ALL
  USING (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  );

ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES organizations(id);
ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON webhook_deliveries;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON webhook_deliveries;
DROP POLICY IF EXISTS breeze_org_isolation_update ON webhook_deliveries;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON webhook_deliveries;
DROP POLICY IF EXISTS webhook_deliveries_isolation ON webhook_deliveries;
CREATE POLICY webhook_deliveries_isolation ON webhook_deliveries FOR ALL
  USING (
    public.breeze_current_scope() = 'system'
    OR EXISTS (
      SELECT 1 FROM webhooks w WHERE w.id = webhook_deliveries.webhook_id
        AND ((w.org_id IS NOT NULL AND public.breeze_has_org_access(w.org_id))
          OR (w.partner_id IS NOT NULL AND public.breeze_has_partner_access(w.partner_id)))
    )
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR EXISTS (
      SELECT 1 FROM webhooks w WHERE w.id = webhook_deliveries.webhook_id
        AND ((w.org_id IS NOT NULL AND public.breeze_has_org_access(w.org_id))
          OR (w.partner_id IS NOT NULL AND public.breeze_has_partner_access(w.partner_id)))
    )
  );

CREATE OR REPLACE FUNCTION webhook_deliveries_org_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  w record;
BEGIN
  SELECT org_id, partner_id INTO w FROM public.webhooks WHERE id = NEW.webhook_id;
  IF NOT FOUND THEN
    RETURN NEW; -- Let the existing webhook_id FK report the missing parent.
  END IF;
  IF w.org_id IS NOT NULL THEN
    NEW.org_id := COALESCE(NEW.org_id, w.org_id);
    IF NEW.org_id <> w.org_id THEN
      RAISE EXCEPTION 'webhook delivery organization does not match its webhook owner' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.org_id IS NULL THEN
    IF NEW.event_id NOT LIKE 'test-%' THEN
      RAISE EXCEPTION 'partner webhook deliveries require an event organization except for test- event ids' USING ERRCODE = '23514';
    END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = NEW.org_id AND partner_id = w.partner_id) THEN
    RAISE EXCEPTION 'webhook delivery organization does not belong to its webhook partner' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION webhook_deliveries_org_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS webhook_deliveries_org_guard ON webhook_deliveries;
CREATE TRIGGER webhook_deliveries_org_guard BEFORE INSERT ON webhook_deliveries
  FOR EACH ROW EXECUTE FUNCTION webhook_deliveries_org_guard();
