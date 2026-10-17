-- Endpoint messaging persistence (#8742, W02 of #8740).
--
-- endpoint_messages            shape 1: direct org_id. One row per send PER ORG
--                              (org-scoped only in v1; no partner-owned row).
-- endpoint_message_deliveries  shape 5: device-scoped hot agent-write table with a
--                              denormalized org_id and a direct
--                              breeze_has_org_access(org_id) policy.
-- endpoint_message_receipts    shape 5: same, one row per (delivery, session, event).
--
-- Tenant consistency: RLS proves only that the caller may write the stated
-- org_id. The composite FKs below prove the referenced message, delivery and
-- device belong to that same org.
--
-- FK timing:
--   * deliveries -> endpoint_messages(id, org_id) is DEFERRABLE INITIALLY
--     IMMEDIATE (fails fast). A device org move must DETACH it first
--     (endpoint_message_id = NULL, moveDeviceOrgInTransaction.ts) because
--     breeze_cascade_device_org_id() restamps the delivery's org_id inside the
--     devices UPDATE; the message and its body stay with the source org.
--   * the device FKs and receipts -> deliveries(id, org_id) are DEFERRABLE
--     INITIALLY DEFERRED, like device_group_memberships and
--     agent_health_observations: the generic device-move restamp loop updates
--     deliveries and receipts in separate statements in catalog order, so the
--     pair is consistent only at COMMIT. A forged row still fails, at COMMIT.
--   All are DEFERRABLE so org merge (SET CONSTRAINTS ALL DEFERRED) can re-point
--   parents and children in separate statements.
--
-- Not append-only at the DB level (plan OD-1): retention nulls bodies and
-- deletes old rows, so no immutability trigger and no AUDIT_ADMIN_REQUIRED_TABLES
-- entry. Receipts are insert-only by application convention.
--
-- Writes no rows. Idempotent. No inner BEGIN/COMMIT.

CREATE TABLE IF NOT EXISTS public.endpoint_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  batch_id uuid NOT NULL,
  client_message_id uuid NOT NULL,
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  target_mode text NOT NULL,
  target_spec jsonb NOT NULL DEFAULT '{}'::jsonb,
  title text,
  body text,
  severity text NOT NULL,
  requires_ack boolean NOT NULL,
  expires_at timestamptz NOT NULL,
  branding jsonb NOT NULL DEFAULT '{}'::jsonb,
  ai_initiator_kind text,
  ai_session_id uuid,
  ai_agent_run_id uuid,
  body_sha256 text NOT NULL,
  body_length integer NOT NULL,
  body_purged_at timestamptz,
  resend_of_id uuid,
  retracted_at timestamptz,
  retracted_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE public.endpoint_messages
    ADD CONSTRAINT endpoint_messages_id_org_id_key UNIQUE (id, org_id);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;

-- Deliberately NOT unique on (org_id, batch_id): a cross-org send writes one row
-- per org under one batch_id, and an org merge repoints both into the survivor.
CREATE INDEX IF NOT EXISTS endpoint_messages_batch_idx
  ON public.endpoint_messages (batch_id);

ALTER TABLE public.endpoint_messages DROP CONSTRAINT IF EXISTS endpoint_messages_severity_chk;
ALTER TABLE public.endpoint_messages
  ADD CONSTRAINT endpoint_messages_severity_chk CHECK (severity IN ('info', 'warning', 'critical'));

-- A body is either present (title and body) or purged (body_purged_at set).
ALTER TABLE public.endpoint_messages DROP CONSTRAINT IF EXISTS endpoint_messages_purge_chk;
ALTER TABLE public.endpoint_messages
  ADD CONSTRAINT endpoint_messages_purge_chk
  CHECK (body_purged_at IS NOT NULL OR (title IS NOT NULL AND body IS NOT NULL));

CREATE INDEX IF NOT EXISTS endpoint_messages_org_created_idx
  ON public.endpoint_messages (org_id, created_at);
CREATE INDEX IF NOT EXISTS endpoint_messages_created_unpurged_idx
  ON public.endpoint_messages (created_at) WHERE body_purged_at IS NULL;

CREATE TABLE IF NOT EXISTS public.endpoint_message_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_message_id uuid,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  command_id uuid,
  status text NOT NULL,
  surface text,
  error_code text,
  delivered_at timestamptz,
  displayed_at timestamptz,
  acknowledged_at timestamptz,
  dismissed_at timestamptz,
  retracted_at timestamptz,
  retract_command_id uuid,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE public.endpoint_message_deliveries
    ADD CONSTRAINT endpoint_message_deliveries_id_org_id_key UNIQUE (id, org_id);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.endpoint_message_deliveries
    ADD CONSTRAINT endpoint_message_deliveries_message_device_key UNIQUE (endpoint_message_id, device_id);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;

ALTER TABLE public.endpoint_message_deliveries DROP CONSTRAINT IF EXISTS endpoint_message_deliveries_status_chk;
ALTER TABLE public.endpoint_message_deliveries
  ADD CONSTRAINT endpoint_message_deliveries_status_chk
  CHECK (status IN ('queued', 'delivered', 'displayed', 'acknowledged', 'dismissed', 'expired', 'retracted', 'failed', 'superseded'));

ALTER TABLE public.endpoint_message_deliveries DROP CONSTRAINT IF EXISTS endpoint_message_deliveries_message_org_fk;
ALTER TABLE public.endpoint_message_deliveries
  ADD CONSTRAINT endpoint_message_deliveries_message_org_fk
  FOREIGN KEY (endpoint_message_id, org_id)
  REFERENCES public.endpoint_messages (id, org_id)
  ON DELETE CASCADE
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE public.endpoint_message_deliveries DROP CONSTRAINT IF EXISTS endpoint_message_deliveries_device_org_fk;
ALTER TABLE public.endpoint_message_deliveries
  ADD CONSTRAINT endpoint_message_deliveries_device_org_fk
  FOREIGN KEY (device_id, org_id)
  REFERENCES public.devices (id, org_id)
  ON DELETE CASCADE
  DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX IF NOT EXISTS endpoint_message_deliveries_message_status_idx
  ON public.endpoint_message_deliveries (endpoint_message_id, status);
CREATE INDEX IF NOT EXISTS endpoint_message_deliveries_device_created_idx
  ON public.endpoint_message_deliveries (device_id, created_at);
CREATE INDEX IF NOT EXISTS endpoint_message_deliveries_command_idx
  ON public.endpoint_message_deliveries (command_id);
CREATE INDEX IF NOT EXISTS endpoint_message_deliveries_org_created_idx
  ON public.endpoint_message_deliveries (org_id, created_at);

CREATE TABLE IF NOT EXISTS public.endpoint_message_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id uuid NOT NULL,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  session_key text NOT NULL,
  session_username text,
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.endpoint_message_receipts DROP CONSTRAINT IF EXISTS endpoint_message_receipts_event_chk;
ALTER TABLE public.endpoint_message_receipts
  ADD CONSTRAINT endpoint_message_receipts_event_chk
  CHECK (event_type IN ('displayed', 'acknowledged', 'dismissed', 'expired'));

ALTER TABLE public.endpoint_message_receipts DROP CONSTRAINT IF EXISTS endpoint_message_receipts_delivery_org_fk;
ALTER TABLE public.endpoint_message_receipts
  ADD CONSTRAINT endpoint_message_receipts_delivery_org_fk
  FOREIGN KEY (delivery_id, org_id)
  REFERENCES public.endpoint_message_deliveries (id, org_id)
  ON DELETE CASCADE
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public.endpoint_message_receipts DROP CONSTRAINT IF EXISTS endpoint_message_receipts_device_org_fk;
ALTER TABLE public.endpoint_message_receipts
  ADD CONSTRAINT endpoint_message_receipts_device_org_fk
  FOREIGN KEY (device_id, org_id)
  REFERENCES public.devices (id, org_id)
  ON DELETE CASCADE
  DEFERRABLE INITIALLY DEFERRED;

CREATE UNIQUE INDEX IF NOT EXISTS endpoint_message_receipts_dedup_uq
  ON public.endpoint_message_receipts (delivery_id, session_key, event_type);
CREATE INDEX IF NOT EXISTS endpoint_message_receipts_device_idx
  ON public.endpoint_message_receipts (device_id, created_at);
CREATE INDEX IF NOT EXISTS endpoint_message_receipts_org_created_idx
  ON public.endpoint_message_receipts (org_id, created_at);

-- RLS: enabled + forced + four policies per table, in this same migration.
ALTER TABLE public.endpoint_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.endpoint_messages FORCE ROW LEVEL SECURITY;
ALTER TABLE public.endpoint_message_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.endpoint_message_deliveries FORCE ROW LEVEL SECURITY;
ALTER TABLE public.endpoint_message_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.endpoint_message_receipts FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['endpoint_messages', 'endpoint_message_deliveries', 'endpoint_message_receipts'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation_select ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation_update ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY breeze_org_isolation_select ON public.%I FOR SELECT USING (public.breeze_has_org_access(org_id))', t);
    EXECUTE format(
      'CREATE POLICY breeze_org_isolation_insert ON public.%I FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id))', t);
    EXECUTE format(
      'CREATE POLICY breeze_org_isolation_update ON public.%I FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id))', t);
    EXECUTE format(
      'CREATE POLICY breeze_org_isolation_delete ON public.%I FOR DELETE USING (public.breeze_has_org_access(org_id))', t);
  END LOOP;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'breeze_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.endpoint_messages TO breeze_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.endpoint_message_deliveries TO breeze_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.endpoint_message_receipts TO breeze_app;
  END IF;
END $$;
