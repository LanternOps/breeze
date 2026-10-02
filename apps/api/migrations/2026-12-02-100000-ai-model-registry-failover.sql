-- AI model registry W09 (#7607): failover provenance.
--
-- ai_invocations (append-only ledger, W02):
--   failover_from_offering_id  the offering the call was routed to BEFORE
--                              failover (NULL when hop = 0, and when the
--                              stored choice no longer exists). Provenance id,
--                              no FK (W02 precedent: an FK's ON DELETE would
--                              be an UPDATE the append-only trigger rejects);
--                              ownership is enforced at INSERT by the
--                              provenance guard below, fail-closed.
--   failover_hop               candidates passed over before the one that
--                              served (0 = no failover; <= 6).
--   failover_cause             why the first candidate was passed over.
-- The row's own offering_id / connection_id / funding_source stay the SERVED
-- offering's (the guard already rejects a funding that disagrees with it), so
-- a failover can never be settled against the requested offering.
--
-- ai_agent_runs: served_offering_id / served_funding_source /
-- served_failover_hop / served_failover_cause record the hop that served the
-- run's model tokens when it was not the admitted offering. funding_source
-- keeps the ADMITTED funding, which still funds sandbox compute (W09 D7). A
-- re-driven run resumes on served_failover_hop's reservation key, so a hop is
-- never reserved twice.
--
-- ai_model_assignments: a row's fallback list holds at most 5 offerings and
-- never its own default (W09 D10).
--
-- The three CHECKs are added NOT VALID here and VALIDATEd in the next file
-- (2026-12-02-100010), in its own transaction: autoMigrate wraps each file in
-- one transaction, so a VALIDATE in this file would scan the ledger while this
-- file's ACCESS EXCLUSIVE lock is still held (W10 precedent, 2026-11-26-100120).
-- NOT VALID still enforces every new or updated row from this commit on.
--
-- Export policy: all seven new columns are `included` (identifiers, a counter,
-- enums), registered in tenantExportPolicyRegistry.ts in the same commit.
-- DDL only: writes no rows, so no system-scope election. Idempotent. No inner
-- BEGIN/COMMIT.

ALTER TABLE public.ai_invocations ADD COLUMN IF NOT EXISTS failover_from_offering_id uuid;
ALTER TABLE public.ai_invocations ADD COLUMN IF NOT EXISTS failover_hop smallint NOT NULL DEFAULT 0;
ALTER TABLE public.ai_invocations ADD COLUMN IF NOT EXISTS failover_cause text;

ALTER TABLE public.ai_invocations DROP CONSTRAINT IF EXISTS ai_invocations_failover_chk;
ALTER TABLE public.ai_invocations ADD CONSTRAINT ai_invocations_failover_chk CHECK (
  failover_hop BETWEEN 0 AND 6
  AND ((failover_hop = 0) = (failover_cause IS NULL))
  AND (failover_hop > 0 OR failover_from_offering_id IS NULL)
  AND (failover_cause IS NULL OR failover_cause IN
       ('ineligible', 'cooldown', 'rate_limited', 'overloaded', 'server_error', 'auth_failed', 'quota_exhausted'))
) NOT VALID;

-- W02's 2026-11-14-100300 body verbatim, plus the one W09 block before RETURN.
-- The BEFORE INSERT trigger is unchanged, so it is not re-created.
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

  -- W09: the failover source is an offering of the same partner.
  IF NEW.failover_from_offering_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.partner_ai_models AS f
     WHERE f.id = NEW.failover_from_offering_id AND f.partner_id = org_partner
  ) THEN
    RAISE EXCEPTION 'failover source % is not an offering of org %''s partner', NEW.failover_from_offering_id, NEW.org_id
      USING ERRCODE = '23503';
  END IF;

  RETURN NEW;
END $$;

ALTER TABLE public.ai_agent_runs ADD COLUMN IF NOT EXISTS served_offering_id uuid;
ALTER TABLE public.ai_agent_runs ADD COLUMN IF NOT EXISTS served_funding_source text;
ALTER TABLE public.ai_agent_runs ADD COLUMN IF NOT EXISTS served_failover_hop smallint;
ALTER TABLE public.ai_agent_runs ADD COLUMN IF NOT EXISTS served_failover_cause text;

ALTER TABLE public.ai_agent_runs DROP CONSTRAINT IF EXISTS ai_agent_runs_served_chk;
ALTER TABLE public.ai_agent_runs ADD CONSTRAINT ai_agent_runs_served_chk CHECK (
  (served_funding_source IS NULL OR served_funding_source IN ('platform', 'partner_key'))
  AND (served_failover_hop IS NULL OR served_failover_hop BETWEEN 1 AND 6)
  AND ((served_offering_id IS NULL) = (served_failover_hop IS NULL))
  AND ((served_offering_id IS NULL) = (served_funding_source IS NULL))
  AND ((served_offering_id IS NULL) = (served_failover_cause IS NULL))
  AND (served_failover_cause IS NULL OR served_failover_cause IN
       ('ineligible', 'cooldown', 'rate_limited', 'overloaded', 'server_error', 'auth_failed', 'quota_exhausted'))
) NOT VALID;

ALTER TABLE public.ai_model_assignments DROP CONSTRAINT IF EXISTS ai_model_assignments_fallback_shape_chk;
ALTER TABLE public.ai_model_assignments ADD CONSTRAINT ai_model_assignments_fallback_shape_chk CHECK (
  fallback_offering_ids IS NULL
  OR (cardinality(fallback_offering_ids) <= 5
      AND (default_offering_id IS NULL OR NOT (default_offering_id = ANY (fallback_offering_ids))))
) NOT VALID;
