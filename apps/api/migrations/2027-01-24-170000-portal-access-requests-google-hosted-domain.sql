-- Portal registration W7: the hd of a Google access request (plan D8).
-- DDL only; system scope first per migrations/README. autoMigrate wraps the file: no BEGIN/COMMIT.
SELECT set_config('breeze.scope', 'system', true);

ALTER TABLE public.portal_access_requests
  ADD COLUMN IF NOT EXISTS google_hosted_domain text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.portal_access_requests'::regclass
                  AND conname = 'portal_access_requests_google_hd_chk') THEN
    ALTER TABLE public.portal_access_requests ADD CONSTRAINT portal_access_requests_google_hd_chk
      CHECK ((source = 'google') = (google_hosted_domain IS NOT NULL)
             AND (google_hosted_domain IS NULL OR google_hosted_domain = lower(btrim(google_hosted_domain))))
      NOT VALID;
  END IF;
  -- Nothing produces a google request before W7 (caps.google was false), so this validates on
  -- every real database. A database that somehow holds one keeps the constraint NOT VALID
  -- (enforced for new rows) instead of failing the deploy.
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.portal_access_requests'::regclass
              AND conname = 'portal_access_requests_google_hd_chk' AND NOT convalidated)
     AND NOT EXISTS (SELECT 1 FROM public.portal_access_requests WHERE source = 'google' AND google_hosted_domain IS NULL) THEN
    ALTER TABLE public.portal_access_requests VALIDATE CONSTRAINT portal_access_requests_google_hd_chk;
  END IF;
END $$;
