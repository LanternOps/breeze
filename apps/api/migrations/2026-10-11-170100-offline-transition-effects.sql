-- Track C: status CAS and durable pending effects commit together. Source ownership
-- is historical: org/device moves never rewrite event payloads or source org IDs.
CREATE TABLE IF NOT EXISTS offline_transition_effects (
  id UUID PRIMARY KEY,
  transition_id TEXT NOT NULL,
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('offline-event','alert-plan','alert-rule','alert-event','alert-postprocess')),
  rule_id UUID,
  cooldown_until TIMESTAMPTZ,
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND payload ? 'type' AND payload->>'type' IS NOT NULL AND payload->>'type' = kind),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_token UUID,
  lease_until TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 80),
  CHECK ((lease_token IS NULL) = (lease_until IS NULL))
);
CREATE INDEX IF NOT EXISTS offline_effects_org_idx ON offline_transition_effects(org_id);
CREATE INDEX IF NOT EXISTS offline_effects_device_rule_created_idx ON offline_transition_effects(device_id,rule_id,created_at);
CREATE INDEX IF NOT EXISTS offline_effects_completed_idx ON offline_transition_effects(completed_at);
CREATE INDEX IF NOT EXISTS offline_effects_due_idx ON offline_transition_effects(available_at,id) WHERE completed_at IS NULL;

CREATE OR REPLACE FUNCTION public.breeze_guard_offline_effect_source()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Invoker rights intentionally fail closed for an RLS-invisible device.
    PERFORM 1 FROM public.devices WHERE id = NEW.device_id AND org_id = NEW.org_id FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'offline effect device ownership mismatch' USING ERRCODE = '23503';
    END IF;
    IF NEW.kind IN ('offline-event','alert-plan','alert-rule') AND
      (NEW.payload#>>'{observation,deviceId}' IS DISTINCT FROM NEW.device_id::text OR
       NEW.payload#>>'{observation,orgId}' IS DISTINCT FROM NEW.org_id::text) THEN
      RAISE EXCEPTION 'offline effect snapshot ownership mismatch' USING ERRCODE = '23514';
    END IF;
    IF NEW.kind = 'alert-event' AND NEW.payload#>>'{event,deviceId}' IS DISTINCT FROM NEW.device_id::text THEN
      RAISE EXCEPTION 'offline alert event device mismatch' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF ROW(NEW.id, NEW.transition_id, NEW.org_id, NEW.device_id, NEW.kind, NEW.rule_id,
           NEW.cooldown_until, NEW.payload, NEW.created_at)
       IS DISTINCT FROM
       ROW(OLD.id, OLD.transition_id, OLD.org_id, OLD.device_id, OLD.kind, OLD.rule_id,
           OLD.cooldown_until, OLD.payload, OLD.created_at) THEN
      RAISE EXCEPTION 'offline effect source is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS offline_effect_source_guard ON offline_transition_effects;
CREATE TRIGGER offline_effect_source_guard BEFORE INSERT OR UPDATE ON offline_transition_effects
FOR EACH ROW EXECUTE FUNCTION public.breeze_guard_offline_effect_source();

-- Outbox writes are system-only: tenant users may inspect their rows, but cannot
-- submit privileged background work by crafting a rule/event payload.
ALTER TABLE offline_transition_effects ENABLE ROW LEVEL SECURITY;
ALTER TABLE offline_transition_effects FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON offline_transition_effects;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON offline_transition_effects;
DROP POLICY IF EXISTS breeze_org_isolation_update ON offline_transition_effects;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON offline_transition_effects;
CREATE POLICY breeze_org_isolation_select ON offline_transition_effects FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON offline_transition_effects FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id) AND current_setting('breeze.scope', true) = 'system');
CREATE POLICY breeze_org_isolation_update ON offline_transition_effects FOR UPDATE USING (public.breeze_has_org_access(org_id) AND current_setting('breeze.scope', true) = 'system') WITH CHECK (public.breeze_has_org_access(org_id) AND current_setting('breeze.scope', true) = 'system');
CREATE POLICY breeze_org_isolation_delete ON offline_transition_effects FOR DELETE USING (public.breeze_has_org_access(org_id) AND current_setting('breeze.scope', true) = 'system');
GRANT SELECT, INSERT, UPDATE, DELETE ON offline_transition_effects TO breeze_app;

-- Preserve the current discovery function verbatim except the new historical
-- outbox exclusion: automatic device-org cascades must not rewrite its source.
CREATE OR REPLACE FUNCTION public.breeze_device_child_orgid_tables()
  RETURNS SETOF text
  LANGUAGE sql
  STABLE
  AS $$
  SELECT t.relname::text
  FROM pg_class t
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relkind = 'r'
    AND t.relname <> 'devices'
    -- ai_agent_runs: agent-run history stays with the SOURCE org on a device
    -- move (owner decision 2026-08-23); its org_id is trigger-immutable.
    -- PAM lifecycle and result evidence is likewise source-frozen, but unlike
    -- agent runs its existence blocks the device move entirely.
    -- invoice_line_devices: billing evidence stays in its INVOICE's org on a
    -- device move. The invoice and its lines do not move, so restamping the
    -- evidence row's org_id here trips invoice_line_devices_line_org_fk /
    -- invoice_line_devices_invoice_org_fk (DEFERRABLE INITIALLY IMMEDIATE) at
    -- the end of the trigger's own statement. moveOrg.ts detaches device_id
    -- instead, and that statement is LOAD-BEARING, not a mirror of this loop
    -- (#3205 W07).
    AND t.relname NOT IN (
      'ai_agent_runs',
      'pam_actuations',
      'pam_actuation_results',
      'invoice_line_devices',
      'offline_transition_effects'
    )
    AND EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = t.oid AND a.attname = 'device_id'
        AND NOT a.attisdropped AND a.atttypid = 'uuid'::regtype
    )
    AND EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = t.oid AND a.attname = 'org_id'
        AND NOT a.attisdropped AND a.atttypid = 'uuid'::regtype
    );
$$;
