-- AI model registry W02 (#7600, spec §5.5, quorum #6): ai_invocations — one
-- immutable row per model call or turn, from every surface, including
-- sessionless agent runs. Shape 1 (org_id).
--
-- W02 writes SHADOW rows (ledger_mode = 'shadow') next to every legacy cost
-- record; billing and budgets still come from the legacy path. W03 writes
-- 'authoritative' rows and derives ai_sessions totals / ai_cost_usage from
-- those only. legacy_cost_cents carries the legacy cost on shadow rows so the
-- W03 go/no-go can query the price diff.
--
-- APPEND-ONLY (precedent ai_operator_task_events, 2026-10-26-160000):
--   * breeze_app: SELECT, INSERT, REFERENCES + column-level UPDATE (org_id).
--     ensureAppRole.ts re-revokes UPDATE/DELETE/TRUNCATE on every boot and
--     re-grants UPDATE (org_id) (a table-level REVOKE also drops column grants).
--   * breeze_audit_admin: SELECT, DELETE (erasure via AUDIT_ADMIN_REQUIRED_TABLES,
--     retention via jobs/aiInvocationRetention.ts), both with
--     breeze.allow_audit_retention = '1'.
--   * ai_invocations_append_only rejects every UPDATE except a SYSTEM-scope
--     org_id-only re-point away from an org fenced 'merging' to an org of the
--     SAME partner (org merge policy 'repoint'; spec §5.5), and every DELETE
--     not made as breeze_audit_admin with the retention GUC.
-- No FKs on user/session/run/offering/connection ids: they are provenance
-- snapshots, and ON DELETE SET NULL would be an UPDATE the trigger rejects.
-- ai_invocations_provenance_guard enforces their tenant ownership at INSERT,
-- fail-closed (quorum #1).
--
-- All four org policies exist because rls-coverage requires them on every
-- shape-1 table; the GRANTs are what make the table append-only.
--
-- Idempotent. Writes no rows.

CREATE TABLE IF NOT EXISTS public.ai_invocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  surface text NOT NULL,
  role text NOT NULL DEFAULT 'default',
  user_id uuid,
  session_id uuid,
  agent_run_id uuid,
  source_ref text,
  offering_id uuid,
  connection_id uuid,
  funding_source text NOT NULL,
  requested_model text NOT NULL,
  served_model text NOT NULL,
  options_sent jsonb NOT NULL DEFAULT '{}'::jsonb,
  thinking_mode_sent text,
  inference_geo_sent text,
  stop_reason text,
  refusal_category text,
  fallback_used boolean NOT NULL DEFAULT false,
  catalog_revision_id uuid,
  connection_config_version integer,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  cache_read_tokens bigint NOT NULL DEFAULT 0,
  cache_write_tokens bigint NOT NULL DEFAULT 0,
  rate_snapshot jsonb,
  cost_cents numeric(20, 6),
  chargeable boolean NOT NULL DEFAULT false,
  sdk_reported_cost_usd numeric(20, 6),
  ledger_mode text NOT NULL DEFAULT 'shadow',
  legacy_cost_cents numeric(20, 6),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ai_invocations DROP CONSTRAINT IF EXISTS ai_invocations_surface_chk;
ALTER TABLE public.ai_invocations ADD CONSTRAINT ai_invocations_surface_chk
  CHECK (surface IN ('chat', 'helper', 'script_builder', 'script_reviewer', 'office_chat',
                     'office_ticket', 'ai_agents', 'catalog_enrichment', 'extension_content', 'patch_test'));

ALTER TABLE public.ai_invocations DROP CONSTRAINT IF EXISTS ai_invocations_role_chk;
ALTER TABLE public.ai_invocations ADD CONSTRAINT ai_invocations_role_chk CHECK (
  role = 'default'
  OR (surface = 'ai_agents' AND role IN ('triage', 'analysis', 'remediation'))
);

ALTER TABLE public.ai_invocations DROP CONSTRAINT IF EXISTS ai_invocations_ledger_mode_chk;
ALTER TABLE public.ai_invocations ADD CONSTRAINT ai_invocations_ledger_mode_chk
  CHECK (ledger_mode IN ('shadow', 'authoritative'));

ALTER TABLE public.ai_invocations DROP CONSTRAINT IF EXISTS ai_invocations_shape_chk;
ALTER TABLE public.ai_invocations ADD CONSTRAINT ai_invocations_shape_chk CHECK (
  funding_source IN ('platform', 'partner_key')
  AND (thinking_mode_sent IS NULL OR thinking_mode_sent IN ('adaptive', 'budget', 'none', 'unknown'))
  AND input_tokens >= 0 AND output_tokens >= 0 AND cache_read_tokens >= 0 AND cache_write_tokens >= 0
  -- priced together or not at all (an unpriced shadow call records NULL/NULL)
  AND (rate_snapshot IS NULL) = (cost_cents IS NULL)
  AND (cost_cents IS NULL OR cost_cents >= 0)
  AND jsonb_typeof(options_sent) = 'object'
  -- legacy cost exists only on shadow rows
  AND (ledger_mode = 'shadow' OR legacy_cost_cents IS NULL)
);

CREATE INDEX IF NOT EXISTS ai_invocations_org_created_idx ON public.ai_invocations (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_invocations_created_idx ON public.ai_invocations (created_at);
CREATE INDEX IF NOT EXISTS ai_invocations_session_idx ON public.ai_invocations (session_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_invocations_agent_run_idx ON public.ai_invocations (agent_run_id) WHERE agent_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_invocations_offering_idx ON public.ai_invocations (offering_id, created_at) WHERE offering_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.ai_invocations_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- The GUC alone is caller-settable; the role is what authenticates it.
    -- Nothing cascades into this table, so there is no trigger-depth exception.
    IF current_user = 'breeze_audit_admin'
       AND current_setting('breeze.allow_audit_retention', true) = '1' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'ai_invocations is append-only',
      HINT = 'Erasure and retention delete as breeze_audit_admin with breeze.allow_audit_retention=1.';
  END IF;

  -- UPDATE: nothing but org_id may change …
  IF (to_jsonb(NEW) - 'org_id') IS DISTINCT FROM (to_jsonb(OLD) - 'org_id') THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'ai_invocations is append-only';
  END IF;
  -- … and only as the org-merge re-point: system scope (a partner caller can
  -- flip an org's status itself, so the fence alone is forgeable), source
  -- fenced 'merging', destination under the same partner.
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     AND public.breeze_current_scope() = 'system'
     AND EXISTS (
       SELECT 1
         FROM public.organizations AS src
         JOIN public.organizations AS dst ON dst.id = NEW.org_id
        WHERE src.id = OLD.org_id
          AND src.status::text = 'merging'
          AND dst.partner_id = src.partner_id
     ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'ai_invocations rows move only with an org merge';
END $$;

DROP TRIGGER IF EXISTS ai_invocations_block_update ON public.ai_invocations;
CREATE TRIGGER ai_invocations_block_update BEFORE UPDATE ON public.ai_invocations
  FOR EACH ROW EXECUTE FUNCTION public.ai_invocations_append_only();
DROP TRIGGER IF EXISTS ai_invocations_block_delete ON public.ai_invocations;
CREATE TRIGGER ai_invocations_block_delete BEFORE DELETE ON public.ai_invocations
  FOR EACH ROW EXECUTE FUNCTION public.ai_invocations_append_only();

-- Insert-time provenance ownership (quorum #1). The provenance ids carry no FK
-- (history must never block a session/run/offering delete), so the tenant
-- boundary is enforced here instead, FAIL-CLOSED, with the writer's RLS: an id
-- the writer can't see is rejected. user_id is attribution only and is not
-- checked (it may be a partner-level user an org token cannot read).
CREATE OR REPLACE FUNCTION public.ai_invocations_provenance_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  org_partner uuid;
  off_partner uuid;
  off_connection uuid;
  off_found boolean := false;
BEGIN
  SELECT o.partner_id INTO org_partner FROM public.organizations AS o WHERE o.id = NEW.org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ai_invocations.org_id % is not a visible organization', NEW.org_id USING ERRCODE = '23503';
  END IF;

  IF NEW.session_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.ai_sessions AS s WHERE s.id = NEW.session_id AND s.org_id = NEW.org_id
  ) THEN
    RAISE EXCEPTION 'session % does not belong to org %', NEW.session_id, NEW.org_id USING ERRCODE = '23503';
  END IF;

  IF NEW.agent_run_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.ai_agent_runs AS r WHERE r.id = NEW.agent_run_id AND r.org_id = NEW.org_id
  ) THEN
    RAISE EXCEPTION 'agent run % does not belong to org %', NEW.agent_run_id, NEW.org_id USING ERRCODE = '23503';
  END IF;

  IF NEW.offering_id IS NOT NULL THEN
    SELECT true, m.partner_id, m.connection_id INTO off_found, off_partner, off_connection
      FROM public.partner_ai_models AS m WHERE m.id = NEW.offering_id;
    IF NOT FOUND OR off_partner IS DISTINCT FROM org_partner THEN
      RAISE EXCEPTION 'offering % is not an offering of org %''s partner', NEW.offering_id, NEW.org_id USING ERRCODE = '23503';
    END IF;
    IF (off_connection IS NULL) <> (NEW.funding_source = 'platform') THEN
      RAISE EXCEPTION 'funding_source % does not match offering %', NEW.funding_source, NEW.offering_id USING ERRCODE = '23514';
    END IF;
    IF NEW.connection_id IS DISTINCT FROM off_connection THEN
      RAISE EXCEPTION 'connection_id must be the offering''s connection' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.connection_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.partner_ai_connections AS c WHERE c.id = NEW.connection_id AND c.partner_id = org_partner
  ) THEN
    RAISE EXCEPTION 'connection % is not a connection of org %''s partner', NEW.connection_id, NEW.org_id USING ERRCODE = '23503';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS ai_invocations_provenance_guard ON public.ai_invocations;
CREATE TRIGGER ai_invocations_provenance_guard BEFORE INSERT ON public.ai_invocations
  FOR EACH ROW EXECUTE FUNCTION public.ai_invocations_provenance_guard();

ALTER TABLE public.ai_invocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_invocations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON public.ai_invocations;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.ai_invocations;
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.ai_invocations;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.ai_invocations;
CREATE POLICY breeze_org_isolation_select ON public.ai_invocations
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON public.ai_invocations
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON public.ai_invocations
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON public.ai_invocations
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, REFERENCES ON public.ai_invocations TO breeze_app;
REVOKE UPDATE, DELETE, TRUNCATE ON public.ai_invocations FROM breeze_app;
GRANT UPDATE (org_id) ON public.ai_invocations TO breeze_app;
GRANT SELECT, DELETE ON public.ai_invocations TO breeze_audit_admin;
REVOKE INSERT, UPDATE, TRUNCATE ON public.ai_invocations FROM breeze_audit_admin;
