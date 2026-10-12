-- PAM ownership epochs W5 (#8207, feature #8202): merge evidence holds and
-- survivor read access. Spec docs/superpowers/specs/pam/2026-10-06-pam-
-- ownership-epoch-design.md §7.
--
-- 1. `org_evidence_holds`: one row per merged-away org (the "loser") whose
--    shell must outlive the merge because it still owns PAM-chain evidence
--    (or because it is itself the survivor of such a shell — a transitive
--    hold). Written by the merge engine in the Phase-B transaction; released
--    only by the erasure path (survivor erasure, or retention emptying the
--    chain). Nothing else releases a hold.
--
--    Tenancy: Shape 3 (partner-axis), flat breeze_has_partner_access
--    (partner_id), like org_merge_events. There is deliberately NO column named
--    org_id: loser_org_id has no FK (the hold row is deleted by the code that
--    erases the shell, never by an FK action) and survivor_org_id is
--    ON DELETE RESTRICT, so erasing a survivor must process its holds first.
--    merge_event_id is RESTRICT too: org_merge_events.survivor_org_id is
--    ON DELETE CASCADE, and a CASCADE here would let a survivor-row delete
--    remove the hold through the event before the survivor RESTRICT ever saw
--    it. Writes and deletes are system-only (RESTRICTIVE policies on top of
--    the partner-axis policy): a hold is evidence custody, and releasing one
--    from a partner context would be evidence destruction by another name.
--
-- 2. `breeze_merged_lineage_org_ids()` / `breeze_has_merged_lineage_access()`:
--    the set of held loser orgs the caller may read history for, walked
--    backward from the caller's accessible orgs through hold rows that agree
--    with their merge event. Depth 5. Every hop is pinned to one partner: the
--    hold, its event, the survivor org and the loser shell must all carry the
--    same partner_id, so a forged row naming another partner's org grants
--    nothing.
--
-- 3. A FOR SELECT policy `breeze_merged_lineage_select` on the six PAM
--    history tables. Never FOR ALL: survivors read held history, they never
--    write, repoint or delete it.
--
-- Idempotent. Writes no rows (DDL only), so no breeze.scope election. No
-- inner BEGIN/COMMIT.

-- ---------------------------------------------------------------------------
-- 1. org_evidence_holds
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.org_evidence_holds (
  loser_org_id    uuid        NOT NULL,
  partner_id      uuid        NOT NULL,
  survivor_org_id uuid        NOT NULL,
  merge_event_id  uuid        NOT NULL,
  reason          varchar(32) NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT org_evidence_holds_pkey PRIMARY KEY (loser_org_id),
  CONSTRAINT org_evidence_holds_partner_id_fkey
    FOREIGN KEY (partner_id) REFERENCES public.partners(id) ON DELETE CASCADE,
  CONSTRAINT org_evidence_holds_survivor_org_id_fkey
    FOREIGN KEY (survivor_org_id) REFERENCES public.organizations(id) ON DELETE RESTRICT,
  CONSTRAINT org_evidence_holds_merge_event_id_fkey
    FOREIGN KEY (merge_event_id) REFERENCES public.org_merge_events(id) ON DELETE RESTRICT,
  CONSTRAINT org_evidence_holds_reason_chk CHECK (reason IN ('pam_evidence', 'transitive')),
  CONSTRAINT org_evidence_holds_not_self_chk CHECK (loser_org_id <> survivor_org_id)
);

CREATE INDEX IF NOT EXISTS org_evidence_holds_survivor_idx ON public.org_evidence_holds (survivor_org_id);
CREATE INDEX IF NOT EXISTS org_evidence_holds_partner_idx ON public.org_evidence_holds (partner_id);
CREATE INDEX IF NOT EXISTS org_evidence_holds_merge_event_idx ON public.org_evidence_holds (merge_event_id);

ALTER TABLE public.org_evidence_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.org_evidence_holds FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_evidence_holds_partner_access ON public.org_evidence_holds;
CREATE POLICY org_evidence_holds_partner_access ON public.org_evidence_holds
  USING (
    public.breeze_current_scope() = 'system'
    OR public.breeze_has_partner_access(partner_id)
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR public.breeze_has_partner_access(partner_id)
  );

-- Writes are system-only on top of the partner-axis policy. SELECT is left to
-- the partner-axis policy so partner staff can see why a shell persists.
DROP POLICY IF EXISTS org_evidence_holds_system_insert ON public.org_evidence_holds;
CREATE POLICY org_evidence_holds_system_insert ON public.org_evidence_holds
  AS RESTRICTIVE FOR INSERT
  WITH CHECK (public.breeze_current_scope() = 'system');
DROP POLICY IF EXISTS org_evidence_holds_system_update ON public.org_evidence_holds;
CREATE POLICY org_evidence_holds_system_update ON public.org_evidence_holds
  AS RESTRICTIVE FOR UPDATE
  USING (public.breeze_current_scope() = 'system')
  WITH CHECK (public.breeze_current_scope() = 'system');
DROP POLICY IF EXISTS org_evidence_holds_system_delete ON public.org_evidence_holds;
CREATE POLICY org_evidence_holds_system_delete ON public.org_evidence_holds
  AS RESTRICTIVE FOR DELETE
  USING (public.breeze_current_scope() = 'system');

-- DELETE is needed by the erasure path (hold release) and by
-- cascadeDeletePartner's partner_id sweep, both under system scope. UPDATE is
-- not granted as intent; ensureAppRole's blanket grant re-adds it, so the
-- trigger below is what actually keeps a hold row immutable.
GRANT SELECT, INSERT, DELETE ON public.org_evidence_holds TO breeze_app;

CREATE OR REPLACE FUNCTION public.org_evidence_holds_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = 'P0001',
    MESSAGE = 'org_evidence_holds is append-only',
    HINT = 'A hold is released by deleting it through the erasure path, never edited.';
END;
$$;

DROP TRIGGER IF EXISTS org_evidence_holds_block_update ON public.org_evidence_holds;
CREATE TRIGGER org_evidence_holds_block_update BEFORE UPDATE ON public.org_evidence_holds
  FOR EACH ROW EXECUTE FUNCTION public.org_evidence_holds_immutable();

-- ---------------------------------------------------------------------------
-- 2. Lineage read set
-- ---------------------------------------------------------------------------
-- WHY THE IN-BODY save/elevate/restore of `breeze.scope` (precedent:
-- 2026-12-06-100100-org-partner-trust-state-resolver.sql): org_evidence_holds,
-- org_merge_events and organizations are FORCE RLS and an org-scoped caller
-- can read none of the first two. A function-attribute SET "breeze.scope" is
-- superuser-only (migrationGucAttributes.test.ts). The caller's accessible
-- org set is captured BEFORE elevating, so the walk is seeded only from orgs
-- the caller can already see; the elevated region is one read-only SELECT;
-- the body has exactly one RETURN, immediately preceded by the restore; an
-- error aborts the (sub)transaction, which rolls the is_local GUC back.
--
-- PARALLEL UNSAFE because set_config is refused inside a parallel operation.
-- The policies call it once per statement through an uncorrelated scalar
-- subquery (an InitPlan), not once per row.
CREATE OR REPLACE FUNCTION public.breeze_merged_lineage_org_ids()
RETURNS uuid[]
LANGUAGE plpgsql
STABLE
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  _prev_scope text := current_setting('breeze.scope', true);
  _seed uuid[];
  _result uuid[] := ARRAY[]::uuid[];
BEGIN
  -- Evaluated in the CALLER's scope, before elevating. System callers already
  -- pass every org policy; an empty or wildcard set seeds nothing.
  IF COALESCE(_prev_scope, '') <> 'system' THEN
    _seed := public.breeze_accessible_org_ids();
  END IF;

  IF _seed IS NOT NULL AND cardinality(_seed) > 0 THEN
    PERFORM set_config('breeze.scope', 'system', true);

    WITH RECURSIVE lineage(org_id, partner_id, depth) AS (
      SELECT h.loser_org_id, h.partner_id, 1
        FROM public.org_evidence_holds h
        JOIN public.org_merge_events e
          ON e.id = h.merge_event_id
         AND e.loser_org_id = h.loser_org_id
         AND e.survivor_org_id = h.survivor_org_id
         AND e.partner_id = h.partner_id
        JOIN public.organizations s ON s.id = h.survivor_org_id AND s.partner_id = h.partner_id
        JOIN public.organizations l ON l.id = h.loser_org_id AND l.partner_id = h.partner_id
       WHERE h.survivor_org_id = ANY(_seed)
      UNION
      SELECT h.loser_org_id, h.partner_id, w.depth + 1
        FROM lineage w
        JOIN public.org_evidence_holds h
          ON h.survivor_org_id = w.org_id
         AND h.partner_id = w.partner_id
        JOIN public.org_merge_events e
          ON e.id = h.merge_event_id
         AND e.loser_org_id = h.loser_org_id
         AND e.survivor_org_id = h.survivor_org_id
         AND e.partner_id = h.partner_id
        JOIN public.organizations l ON l.id = h.loser_org_id AND l.partner_id = h.partner_id
       WHERE w.depth < 5
    )
    SELECT COALESCE(array_agg(DISTINCT org_id), ARRAY[]::uuid[]) INTO _result FROM lineage;

    PERFORM set_config('breeze.scope', COALESCE(_prev_scope, ''), true);
  END IF;

  RETURN _result;
END;
$$;

COMMENT ON FUNCTION public.breeze_merged_lineage_org_ids() IS
  'Held loser orgs (org_evidence_holds) whose PAM history the caller may read: walked backward from the caller''s accessible orgs, depth 5, every hop partner-pinned and hold/event-consistent. SELECT-only lineage branch input.';

CREATE OR REPLACE FUNCTION public.breeze_has_merged_lineage_access(p_org uuid)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT p_org IS NOT NULL AND p_org = ANY(public.breeze_merged_lineage_org_ids());
$$;

COMMENT ON FUNCTION public.breeze_has_merged_lineage_access(uuid) IS
  'True when p_org is a held loser org in the caller''s merged lineage (see breeze_merged_lineage_org_ids). Point check; the RLS policies use the set form once per statement.';

-- EXECUTE goes to every role that reads these six tables: a policy expression
-- runs with the QUERYING role's privileges, so a role without EXECUTE fails
-- every statement on the table, not just the lineage branch. Today that is
-- breeze_app and breeze_audit_admin (the retention and erasure DELETEs on
-- pam_actuation_results run as it). A role added later that reads these
-- tables needs the same grant.
REVOKE ALL ON FUNCTION public.breeze_merged_lineage_org_ids() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_has_merged_lineage_access(uuid) FROM PUBLIC;
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['breeze_app', 'breeze_audit_admin'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.breeze_merged_lineage_org_ids() TO %I', r);
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.breeze_has_merged_lineage_access(uuid) TO %I', r);
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 3. SELECT-only lineage policies
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'pam_actuations',
    'pam_actuation_results',
    'elevation_requests',
    'elevation_audit',
    'device_ownership_epochs',
    'device_ownership_epoch_closures'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS breeze_merged_lineage_select ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY breeze_merged_lineage_select ON public.%I
         FOR SELECT
         USING (org_id = ANY ((SELECT public.breeze_merged_lineage_org_ids())::uuid[]))', t);
  END LOOP;
END $$;
