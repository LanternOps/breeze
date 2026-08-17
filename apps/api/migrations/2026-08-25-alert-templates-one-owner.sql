-- Security review 2026-08-16 §1.5 (CRITICAL) — cross-org alert-template read.
--
-- alert_templates has carried a partner_id axis since #1357, but never a
-- one-owner CHECK. The create route denormalized partner_id onto ORG-owned
-- rows ("for RLS consistency"), so a legal stored row could have BOTH org_id
-- and partner_id set. templateScopeCondition() then ORed in a bare
-- `partner_id = <caller partner>` as though it selected only partner-wide
-- rows; it selected every template under the partner, voiding the
-- `org_id IN (accessible orgs)` restriction beside it. For a partner-scope
-- caller with orgAccess 'selected'/'none' that was a genuine cross-org read —
-- partner-axis RLS is flat, so the database did not catch it.
--
-- The predicate is fixed in code (partner-wide == partner_id set AND org_id
-- NULL). This migration removes the ambiguous shape from existing data and
-- makes it unrepresentable going forward.
--
-- NOTE: this is deliberately a "never BOTH" constraint, not the usual strict
-- XOR the other `<table>_one_owner_chk` constraints use. alert_templates has
-- two legitimate ownerless shapes that a strict XOR would reject and that would
-- make ADD CONSTRAINT fail on an existing database:
--   * seeded global built-ins (org_id NULL, partner_id NULL, is_built_in true —
--     0018 / 0060 / 2026-08-12);
--   * rows a SYSTEM-scope caller created through POST /alert-templates/templates
--     with no orgId in the body (routes/alertTemplates/templates.ts). Those are
--     inert (no owner, not built-in, so no scoped read selects them) but they
--     may exist and must not block the migration on a live database.
-- "Never both" is exactly the security-relevant invariant: the leak came from
-- rows with BOTH axes set, never from rows with neither.

-- 1. Backfill: an org-owned row keeps org_id and drops the denormalized
--    partner_id. The row count is RAISEd because these rows are exactly the
--    ones that could have been read cross-org through the old predicate —
--    losing that forensic signal would be worse than the fix.
DO $$
DECLARE
  n integer;
BEGIN
  UPDATE public.alert_templates
     SET partner_id = NULL
   WHERE org_id IS NOT NULL
     AND partner_id IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'cleaned % alert_templates rows with both org_id and partner_id set (security review 2026-08-16 s1.5)', n;
  END IF;
END $$;

-- 2. Report (do not touch) ownerless non-built-in rows. These are a data
--    hygiene problem, not a leak — nothing can select them — but the count is
--    worth having in the logs alongside the backfill above.
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n
    FROM public.alert_templates
   WHERE org_id IS NULL AND partner_id IS NULL AND is_built_in = false;
  IF n > 0 THEN
    RAISE WARNING 'found % ownerless non-built-in alert_templates rows (no org_id, no partner_id) - inert, left in place', n;
  END IF;
END $$;

-- 3. Make the ambiguous shape unrepresentable.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'alert_templates_one_owner_chk'
      AND conrelid = 'public.alert_templates'::regclass
  ) THEN
    ALTER TABLE public.alert_templates
      ADD CONSTRAINT alert_templates_one_owner_chk
      CHECK (org_id IS NULL OR partner_id IS NULL);
  END IF;
END $$;

-- 4. Partner-wide lookups filter on (partner_id, org_id IS NULL) now that the
--    predicate carries the extra conjunct.
CREATE INDEX IF NOT EXISTS alert_templates_partner_id_idx
  ON public.alert_templates(partner_id);
