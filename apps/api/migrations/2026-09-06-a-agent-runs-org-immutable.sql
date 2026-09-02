-- AI agents wave 3b (#3824): agent-run history stays with the source org.
--
-- Owner decision 2026-08-23: when a device moves between orgs, its
-- ai_agent_runs (and the action_intents attributed to them via the composite
-- tenant FK) do NOT follow. moveOrg.ts now detaches device_id instead of
-- re-stamping org_id, and ai_agent_runs is no longer in
-- CORE_DEVICE_ORG_DENORMALIZED_TABLES. With that, no legitimate writer of
-- org_id remains, so it joins the immutable set the 2026-09-02 migration
-- deliberately left it out of ("moveOrg re-stamps it in the same
-- transaction") — that rationale is now retired.
--
-- THREE function replacements, all fix-forward (the shipped 2026-05-18 and
-- 2026-09-02 files are untouched). CREATE OR REPLACE replaces the WHOLE body:
-- each block below is the live pg_get_functiondef output plus ONLY the change
-- its comment names — verify before commit, a dropped line is a permanently
-- missing guard.

-- 1) The DB-layer device-move cascade (#750, 2026-05-18) discovers every
--    table carrying uuid device_id + uuid org_id dynamically, so it would
--    keep re-stamping ai_agent_runs.org_id on ANY devices.org_id flip —
--    raising against the immutability guard below (and, before that guard,
--    23503 against the action_intents composite tenant FK the moment an
--    agent proposal existed). ai_agent_runs is the one device-child table
--    whose org_id must NOT follow the device, so exclude it from discovery.
--    (The rls-coverage drift audit iterates this same function; retained
--    runs are detached — device_id NULL — so they can never drift anyway.)
--    Change vs live body: the `t.relname <> 'ai_agent_runs'` predicate.
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
    AND t.relname <> 'ai_agent_runs'
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

-- 2) The cascade trigger enforces the owner decision at the DB layer for
--    EVERY path that flips devices.org_id (the 2026-05-18 rationale: org
--    moves also come from ops/direct SQL, not just the moveOrg route): it
--    now severs the moved device's run lineage instead of re-stamping it.
--    All three FKs are ON DELETE SET NULL — nullable by design. alerts and
--    ai_sessions DO follow the device (re-stamped by the loop), so a
--    retained source-org run keeping alert_id/session_id would point across
--    tenants. moveOrg.ts runs the same detach explicitly; after this
--    trigger fires it matches nothing, which is fine (idempotent).
--    Change vs live body: the ai_agent_runs detach UPDATE before the loop.
CREATE OR REPLACE FUNCTION public.breeze_cascade_device_org_id()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_catalog
  AS $$
DECLARE
  child_table text;
BEGIN
  -- Agent-run history stays with the SOURCE org (owner decision 2026-08-23):
  -- sever the moved device's lineage links instead of re-stamping org_id.
  UPDATE public.ai_agent_runs
    SET device_id = NULL, alert_id = NULL, session_id = NULL
    WHERE device_id = NEW.id;
  FOR child_table IN SELECT public.breeze_device_child_orgid_tables() LOOP
    EXECUTE format(
      'UPDATE public.%I SET org_id = $1 WHERE device_id = $2 AND org_id IS DISTINCT FROM $1',
      child_table
    ) USING NEW.org_id, NEW.id;
  END LOOP;
  RETURN NULL; -- AFTER trigger; return value ignored
END;
$$;

-- 3) The immutability guard (2026-09-02) gains org_id: with moveOrg no
--    longer re-stamping and the cascade above no longer touching the table,
--    no legitimate writer of org_id remains. RLS WITH CHECK still fences
--    cross-org writes; this also stops a same-actor rewrite.
--    Change vs live body: the org_id line.
CREATE OR REPLACE FUNCTION public.ai_agent_runs_immutable_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.agent_id IS DISTINCT FROM OLD.agent_id
     OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.trigger_kind IS DISTINCT FROM OLD.trigger_kind
     OR NEW.trigger_event_id IS DISTINCT FROM OLD.trigger_event_id
     OR NEW.trigger_ref IS DISTINCT FROM OLD.trigger_ref
     OR NEW.dedupe_key IS DISTINCT FROM OLD.dedupe_key
     OR NEW.mode_at_start IS DISTINCT FROM OLD.mode_at_start
     OR NEW.policy_snapshot IS DISTINCT FROM OLD.policy_snapshot THEN
    RAISE EXCEPTION 'ai_agent_runs: immutable column changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
