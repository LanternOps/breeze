-- #9315. A deliverable template item decides whether the deliverables it
-- creates are visible in the customer portal. applyTemplateSet used to
-- hard-code portal_visible = true, so internal onboarding items ("Billing
-- configured", "Agreement signed") always reached the portal.
--
-- Default (maintainer decision on #9315, option A): OFF for one-time items,
-- ON for recurring ones. That rule lives in the service and UI
-- (defaultPortalVisibleForCadence); the column DEFAULT is true and covers raw
-- inserts only, because the service always writes the value explicitly.
--
-- Existing one-time items get the same default as new ones. Deliverables
-- already created from templates are NOT touched. The backfill sits inside
-- the same IF NOT EXISTS guard as the ADD COLUMN, so it runs only on the
-- first apply; a re-apply never overwrites a choice an editor made later.
-- deliverable_template_items carries no partner-export triggers, so no
-- pre-locks are needed.

SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE
  n integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'deliverable_template_items'
       AND column_name = 'portal_visible'
  ) THEN
    ALTER TABLE deliverable_template_items
      ADD COLUMN portal_visible boolean NOT NULL DEFAULT true;

    UPDATE deliverable_template_items
       SET portal_visible = false
     WHERE cadence = 'one_time';
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN
      RAISE WARNING 'deliverable_template_items: % one-time item(s) set to portal_visible = false (#9315)', n;
    END IF;
  END IF;
END $$;

COMMENT ON COLUMN deliverable_template_items.portal_visible IS
  'Copied onto service_deliverables.portal_visible by applyTemplateSet (#9315). The service resolves an unset value from cadence (off for one_time, on for recurring); the column DEFAULT true covers raw inserts only.';
