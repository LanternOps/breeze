/**
 * The legacy `portal_users` Entra objects, as they stood before
 * 2027-01-28-220000-portal-users-drop-entra-columns.sql removed them (portal
 * registration W10 #11387, PR-B): the two columns, their partial unique index
 * (2026-06-12-b-client-ai-foundation.sql) and the W2 browser_access fill
 * trigger + function (2027-01-22-230200-portal-account-foundations.sql).
 *
 * A fresh `autoMigrate` still runs every migration that reads them (the W2 /
 * W3 / W10 backfills) before the drop, so a self-hoster who skips versions is
 * covered. Suites that REPLAY one of those files against the fully-migrated
 * test database put the objects back first.
 *
 * Use it ONLY inside a transaction that is rolled back. A later file's
 * tenant-export contract fails on columns the registry no longer classifies.
 */
export const RESTORE_PORTAL_USERS_LEGACY_ENTRA_SQL = `
  ALTER TABLE public.portal_users ADD COLUMN IF NOT EXISTS entra_oid text;
  ALTER TABLE public.portal_users ADD COLUMN IF NOT EXISTS entra_tenant_id text;
  CREATE UNIQUE INDEX IF NOT EXISTS portal_users_entra_identity_uniq
    ON public.portal_users (entra_tenant_id, entra_oid) WHERE entra_oid IS NOT NULL;
`;

export const RESTORE_PORTAL_USERS_FILL_TRIGGER_SQL = `
  CREATE OR REPLACE FUNCTION public.breeze_portal_users_fill_browser_access()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF NEW.browser_access IS NULL THEN
      NEW.browser_access := CASE WHEN NEW.auth_method = 'password' THEN 'granted' ELSE 'none' END;
    END IF;
    RETURN NEW;
  END $$;
  DROP TRIGGER IF EXISTS portal_users_browser_access_fill ON public.portal_users;
  CREATE TRIGGER portal_users_browser_access_fill
    BEFORE INSERT ON public.portal_users
    FOR EACH ROW EXECUTE FUNCTION public.breeze_portal_users_fill_browser_access();
`;
