-- 2026-10-01-100000: forced parent-join RLS for the two script CHILD tables
-- that shipped in 0001-baseline.sql with NO row-level security (RMM-QA-220).
--
-- Threat: script_versions carries customer script content + history and
-- script_to_tags pairs a script with a tag; both reach their tenant only
-- through scripts.script_id / script_tags.tag_id (no org_id), so they were
-- invisible to the org_id auto-discovery AND absent from every allowlist in
-- rls-coverage.integration.test.ts while breeze_app held blanket DML
-- (ensureAppRole.ts). This migration closes the DB invariant; the companion
-- test changes make the catalog exhaustive so the class cannot recur.
--
-- Shape: the canonical FK-child shape of 2026-05-30-fk-child-tables-rls.sql
-- (DROP IF EXISTS x4, ENABLE + FORCE, four per-command policies named
-- breeze_org_isolation_*), with predicates that MIRROR the parents' reviewed
-- policies rather than a plain breeze_has_org_access(parent.org_id):
--
--   R(s)  scripts read      = breeze_has_org_access(s.org_id)
--                             OR breeze_has_partner_access(s.partner_id)
--                             OR s.is_system
--                             OR (s.org_id IS NULL AND s.partner_id = breeze_current_partner_id())
--           (identical to scripts.breeze_dual_axis_select,
--            2026-06-13-catalog-partner-read-branch.sql)
--   W(s)  scripts write     = breeze_has_org_access(s.org_id)
--                             OR breeze_has_partner_access(s.partner_id)
--           (identical to scripts.breeze_dual_axis_insert/update/delete,
--            2026-06-13-catalog-partner-axis-rls.sql)
--   T(t)  script_tags read  = breeze_has_org_access(t.org_id)
--                             OR breeze_has_partner_access(t.partner_id)
--                             OR (t.org_id IS NULL AND t.partner_id = breeze_current_partner_id())
--           (identical to script_tags.breeze_dual_axis_select)
--
--   script_versions: SELECT R(s); INSERT W(s); UPDATE W(s)/W(s); DELETE W(s).
--   script_to_tags:  SELECT R(s) AND T(t); INSERT W(s) AND T(t);
--                    UPDATE USING W(s) WITH CHECK (W(s) AND T(t)); DELETE W(s).
--
-- is_system appears ONLY in SELECT. It must NEVER be in an INSERT/UPDATE/
-- DELETE predicate (2026-06-13-catalog-partner-axis-rls.sql:62-68, Discussion
-- #633 — `OR is_system` in a WITH CHECK is cross-tenant script injection).
-- System seeding runs under system scope, where W(s) is already TRUE.
--
-- Tag asymmetry (script_to_tags): INSERT and the UPDATE check gate on the tag
-- being READABLE, not writable, so an org user may attach its own script to
-- its MSP's partner-wide tag (the partner-wide-first use case; precedent
-- 2026-09-25-a-automation-resource-bindings.sql). Unlink authority (UPDATE
-- USING / DELETE) comes from the SCRIPT write predicate only, so merely
-- seeing a partner tag never lets a user unlink it from another org's script.
-- The UPDATE WITH CHECK re-applies the tag leg so a link cannot be re-pointed
-- at an invisible tag.
--
-- Bound parameters: the 2026-05-31 script_execution_batches note concerns an
-- INSERT WITH CHECK that ORs `s.is_system`; these write predicates carry no
-- such branch. The only is_system branch here is in SELECT, the same nested-
-- EXISTS shape role_permissions has run in production since 2026-06-13-b.
--
-- The nested EXISTS runs as breeze_app, so the parents' own SELECT policies
-- filter it too: child visibility can never exceed parent visibility.
--
-- Idempotent: DROP POLICY IF EXISTS x4 before each CREATE; ENABLE/FORCE are
-- no-ops when already set. No data change, so no row-count reporting applies.
-- autoMigrate wraps each migration file in a transaction — no inner BEGIN/COMMIT.

-- ---------------------------------------------------------------------------
-- script_versions  ->  scripts(script_id)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS breeze_org_isolation_select ON public.script_versions;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.script_versions;
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.script_versions;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.script_versions;
ALTER TABLE public.script_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.script_versions FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_org_isolation_select ON public.script_versions FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM scripts s
    WHERE s.id = script_versions.script_id
      AND (
        public.breeze_has_org_access(s.org_id)
        OR public.breeze_has_partner_access(s.partner_id)
        OR s.is_system
        OR (s.org_id IS NULL AND s.partner_id = public.breeze_current_partner_id())
      )
  )
);
CREATE POLICY breeze_org_isolation_insert ON public.script_versions FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM scripts s
    WHERE s.id = script_versions.script_id
      AND (public.breeze_has_org_access(s.org_id) OR public.breeze_has_partner_access(s.partner_id))
  )
);
CREATE POLICY breeze_org_isolation_update ON public.script_versions FOR UPDATE USING (
  EXISTS (
    SELECT 1 FROM scripts s
    WHERE s.id = script_versions.script_id
      AND (public.breeze_has_org_access(s.org_id) OR public.breeze_has_partner_access(s.partner_id))
  )
) WITH CHECK (
  EXISTS (
    SELECT 1 FROM scripts s
    WHERE s.id = script_versions.script_id
      AND (public.breeze_has_org_access(s.org_id) OR public.breeze_has_partner_access(s.partner_id))
  )
);
CREATE POLICY breeze_org_isolation_delete ON public.script_versions FOR DELETE USING (
  EXISTS (
    SELECT 1 FROM scripts s
    WHERE s.id = script_versions.script_id
      AND (public.breeze_has_org_access(s.org_id) OR public.breeze_has_partner_access(s.partner_id))
  )
);

-- ---------------------------------------------------------------------------
-- script_to_tags  ->  scripts(script_id)  AND  script_tags(tag_id)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS breeze_org_isolation_select ON public.script_to_tags;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.script_to_tags;
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.script_to_tags;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.script_to_tags;
ALTER TABLE public.script_to_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.script_to_tags FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_org_isolation_select ON public.script_to_tags FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM scripts s
    WHERE s.id = script_to_tags.script_id
      AND (
        public.breeze_has_org_access(s.org_id)
        OR public.breeze_has_partner_access(s.partner_id)
        OR s.is_system
        OR (s.org_id IS NULL AND s.partner_id = public.breeze_current_partner_id())
      )
  )
  AND EXISTS (
    SELECT 1 FROM script_tags t
    WHERE t.id = script_to_tags.tag_id
      AND (
        public.breeze_has_org_access(t.org_id)
        OR public.breeze_has_partner_access(t.partner_id)
        OR (t.org_id IS NULL AND t.partner_id = public.breeze_current_partner_id())
      )
  )
);
CREATE POLICY breeze_org_isolation_insert ON public.script_to_tags FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM scripts s
    WHERE s.id = script_to_tags.script_id
      AND (public.breeze_has_org_access(s.org_id) OR public.breeze_has_partner_access(s.partner_id))
  )
  AND EXISTS (
    SELECT 1 FROM script_tags t
    WHERE t.id = script_to_tags.tag_id
      AND (
        public.breeze_has_org_access(t.org_id)
        OR public.breeze_has_partner_access(t.partner_id)
        OR (t.org_id IS NULL AND t.partner_id = public.breeze_current_partner_id())
      )
  )
);
CREATE POLICY breeze_org_isolation_update ON public.script_to_tags FOR UPDATE USING (
  EXISTS (
    SELECT 1 FROM scripts s
    WHERE s.id = script_to_tags.script_id
      AND (public.breeze_has_org_access(s.org_id) OR public.breeze_has_partner_access(s.partner_id))
  )
) WITH CHECK (
  EXISTS (
    SELECT 1 FROM scripts s
    WHERE s.id = script_to_tags.script_id
      AND (public.breeze_has_org_access(s.org_id) OR public.breeze_has_partner_access(s.partner_id))
  )
  AND EXISTS (
    SELECT 1 FROM script_tags t
    WHERE t.id = script_to_tags.tag_id
      AND (
        public.breeze_has_org_access(t.org_id)
        OR public.breeze_has_partner_access(t.partner_id)
        OR (t.org_id IS NULL AND t.partner_id = public.breeze_current_partner_id())
      )
  )
);
CREATE POLICY breeze_org_isolation_delete ON public.script_to_tags FOR DELETE USING (
  EXISTS (
    SELECT 1 FROM scripts s
    WHERE s.id = script_to_tags.script_id
      AND (public.breeze_has_org_access(s.org_id) OR public.breeze_has_partner_access(s.partner_id))
  )
);
