-- script_categories.parent_id: make the self-reference erasure-safe (#4873).
--
-- THE DEFECT. `script_categories` is partner-wide-first (epic #2135): `org_id`
-- is NULLABLE, so a category can be org-owned (`org_id` set) or partner-wide
-- (`org_id` NULL, `partner_id` set). GDPR org erasure empties the table with a
-- single `DELETE ... WHERE org_id = $1`, which is only safe for a
-- self-referencing FK when the deleted row set is CLOSED under that reference.
-- A nullable `org_id` breaks the closure: a surviving partner-wide category
-- whose `parent_id` points at an org-owned one raises 23503 and aborts the
-- erasure mid-walk. Found by the FK ON DELETE contract test (#4863 / #4519)
-- and reproduced against Postgres 16.
--
-- THE FIX, in two independent layers:
--
--   1. `ON DELETE SET NULL` on `parent_id` — every referencing column is
--      nullable, so Postgres clears the edge itself and the DELETE can no
--      longer raise, whatever the data looks like. This is what takes the edge
--      off `orgCascadeFkOnDeleteAllowlist.ts`.
--   2. A DEFERRABLE constraint trigger making the offending shape
--      unconstructible in the first place: a child may only name a parent on
--      its own owner axis. Modelled on `configuration_policies_parent_guard`
--      (2026-10-12-100000-config-policy-inheritance.sql, #5080 W01), which
--      closes the identical shape for configuration policies.
--
-- Layer 2 is the whole of the enforcement: `script_categories` has NO create or
-- update route today (the table is schema-only — verified by grepping
-- `scriptCategories` across apps/api/src), so there is no app-layer call site
-- to guard. Putting the rule in the database means the invariant is already
-- enforced whenever those routes are written, rather than depending on whoever
-- writes them remembering it.
--
-- Ownership rule (mirrors the dual-axis shape this table actually has: an
-- org-owned row carries BOTH org_id and its org's partner_id — see the
-- 2026-06-13 backfill — so partner_id alone does not identify the axis;
-- `org_id IS NULL` does):
--   * org-owned child   -> a same-org parent, or a partner-wide parent of that
--                          org's partner;
--   * partner-wide child-> only a partner-wide parent of the same partner;
--   * legacy global row (org_id AND partner_id both NULL, left by the
--     2026-06-13 partner-axis backfill for built-in rows) -> only another
--     global row. Kept legal rather than rejected so an existing built-in
--     hierarchy is not nulled out; it is closed under erasure regardless.
--
-- Idempotent; no inner BEGIN/COMMIT. Contains DML (the cleanup below), so it
-- elects system scope first.

SELECT set_config('breeze.scope', 'system', true);

-- ============================================================
-- 1. Ownership compatibility helper
-- ============================================================
-- SECURITY DEFINER like breeze_config_policy_parent_compatible: where the
-- migration/session role carries BYPASSRLS this makes the guard's reads
-- authoritative rather than invoker-limited; where it does not, the guard
-- degrades to FAIL-CLOSED (an RLS-invisible parent reads as NOT FOUND and is
-- rejected). The ownership RULE, not row visibility, is what rejects an edge.
CREATE OR REPLACE FUNCTION public.breeze_script_category_parent_compatible(
  child_org uuid, child_partner uuid, parent_org uuid, parent_partner uuid
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  -- STRICTLY two-valued. Every comparison inside can yield NULL (`parent_org =
  -- child_org` is NULL for a partner-wide parent; the organizations sub-select
  -- is NULL for a missing or RLS-invisible org). Under three-valued logic
  -- `NULL OR false` is NULL and `IF NOT compatible(...)` would NOT fire, which
  -- is a fail-OPEN guard. The outer COALESCE collapses every unknown to false;
  -- the caller additionally tests `IS NOT TRUE` as defence in depth.
  SELECT COALESCE(
    CASE
      WHEN child_org IS NOT NULL THEN
        parent_org = child_org
        OR (parent_org IS NULL AND parent_partner IS NOT NULL
            AND parent_partner = (SELECT o.partner_id FROM public.organizations o WHERE o.id = child_org))
      WHEN child_partner IS NOT NULL THEN
        parent_org IS NULL AND parent_partner = child_partner
      ELSE
        -- Legacy global row: only another global row.
        parent_org IS NULL AND parent_partner IS NULL
    END,
    false
  );
$$;

-- Not a public oracle for "does org X belong to partner P".
REVOKE ALL ON FUNCTION public.breeze_script_category_parent_compatible(uuid, uuid, uuid, uuid) FROM PUBLIC;

-- ============================================================
-- 2. Clean up rows that already violate the rule
-- ============================================================
-- Detaching (parent_id -> NULL) rather than deleting: the category itself is
-- customer data. Row counts land in the Postgres log so the forensic trail
-- survives even when the count is 0 — a non-zero count here would mean a
-- tenant's erasure was already broken.
DO $$
DECLARE
  n integer;
BEGIN
  UPDATE public.script_categories c
     SET parent_id = NULL
    FROM public.script_categories p
   WHERE c.parent_id = p.id
     AND c.id <> p.id
     AND public.breeze_script_category_parent_compatible(c.org_id, c.partner_id, p.org_id, p.partner_id) IS NOT TRUE;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'cleaned % script_categories row(s) whose parent_id crossed the ownership axis', n;
  END IF;

  -- Self-parenting rows, which the CHECK below would otherwise reject.
  UPDATE public.script_categories SET parent_id = NULL WHERE parent_id = id;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'cleaned % self-parenting script_categories row(s)', n;
  END IF;
END $$;

-- ============================================================
-- 3. ON DELETE SET NULL on the self-reference
-- ============================================================
-- Keeps the drizzle-generated constraint name so the catalog stays aligned
-- with apps/api/src/db/schema/scripts.ts.
ALTER TABLE public.script_categories
  DROP CONSTRAINT IF EXISTS script_categories_parent_id_script_categories_id_fk;
ALTER TABLE public.script_categories
  ADD CONSTRAINT script_categories_parent_id_script_categories_id_fk
  FOREIGN KEY (parent_id) REFERENCES public.script_categories(id) ON DELETE SET NULL;

ALTER TABLE public.script_categories
  DROP CONSTRAINT IF EXISTS script_categories_not_own_parent_chk;
ALTER TABLE public.script_categories
  ADD CONSTRAINT script_categories_not_own_parent_chk
  CHECK (parent_id IS NULL OR parent_id <> id);

COMMENT ON COLUMN public.script_categories.parent_id IS
  'Optional parent category. ON DELETE SET NULL so org erasure can never be blocked by this '
  'self-reference (#4873). Ownership rule (enforced by script_categories_parent_guard): an '
  'org-owned child names a same-org parent or a partner-wide parent of its org''s partner; a '
  'partner-wide child names only a partner-wide parent of the same partner.';

-- ============================================================
-- 4. Ownership guard
-- ============================================================
-- DEFERRABLE INITIALLY IMMEDIATE: org merge runs SET CONSTRAINTS ALL DEFERRED
-- and re-points parent and child org_id in separate statements, so validation
-- has to be able to happen at COMMIT, by which time the whole family has moved.
CREATE OR REPLACE FUNCTION public.breeze_script_category_parent_guard()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  p RECORD;
BEGIN
  -- Outgoing edge: this row's own parent.
  IF NEW.parent_id IS NOT NULL THEN
    SELECT sc.org_id, sc.partner_id INTO p
      FROM public.script_categories sc WHERE sc.id = NEW.parent_id;
    IF NOT FOUND
       OR public.breeze_script_category_parent_compatible(NEW.org_id, NEW.partner_id, p.org_id, p.partner_id) IS NOT TRUE THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        CONSTRAINT = 'script_categories_parent_guard',
        MESSAGE = 'parent script category not found or not on the same owner axis';
    END IF;
  END IF;

  -- Incoming edges: rows naming this one as their parent. Only checked when
  -- ownership actually moved — an ordinary UPDATE (including the ON DELETE SET
  -- NULL above, which fires this trigger) must not pay for the scan.
  IF TG_OP = 'UPDATE'
     AND (NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.partner_id IS DISTINCT FROM OLD.partner_id)
     AND EXISTS (
       SELECT 1 FROM public.script_categories c
        WHERE c.parent_id = NEW.id
          AND public.breeze_script_category_parent_compatible(c.org_id, c.partner_id, NEW.org_id, NEW.partner_id) IS NOT TRUE
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      CONSTRAINT = 'script_categories_parent_guard',
      MESSAGE = 'ownership change would orphan child script categories';
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.breeze_script_category_parent_guard() FROM PUBLIC;

DROP TRIGGER IF EXISTS script_categories_parent_guard ON public.script_categories;
CREATE CONSTRAINT TRIGGER script_categories_parent_guard
  AFTER INSERT OR UPDATE OF parent_id, org_id, partner_id
  ON public.script_categories
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION public.breeze_script_category_parent_guard();
