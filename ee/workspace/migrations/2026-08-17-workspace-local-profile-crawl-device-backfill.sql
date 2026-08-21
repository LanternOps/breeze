-- #3472: `local_profile` sources must never carry a crawl device.
--
-- Nothing enforced that before: validateSmbConfig returned early for
-- local_profile, validateCreate did the same, and sourcesService.update did no
-- state validation at all. So existing rows can hold the forbidden shape — the
-- service's own test fixture defaulted to exactly it.
--
-- The shape is not inert. listForDevice returns every active local_profile in
-- the org PLUS rows assigned to the calling device, so a stranded crawl device
-- hands one device the other device's device-scoped rows.
--
-- It also breaks editing once validation lands. The admin form seeds the crawl
-- device from the row it is editing (web/sourcesPage.ts) and resubmits it, so
-- without this backfill every PATCH against a legacy row would 400 and the
-- operator could not clear it through the UI.
--
-- Idempotent: the predicate only matches rows still holding the forbidden
-- shape, so re-applying is a no-op.
DO $$
DECLARE
  n integer;
BEGIN
  UPDATE workspace_sources
  SET crawl_device_id = NULL
  WHERE kind = 'local_profile'
    AND crawl_device_id IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'cleared crawl_device_id on % local_profile workspace_source(s) (#3472)', n;
  END IF;
END $$;
