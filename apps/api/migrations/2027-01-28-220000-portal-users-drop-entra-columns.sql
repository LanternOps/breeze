-- Portal registration W10 (#11387), identities release C, PR-B: drop the legacy
-- portal_users Entra objects. Plan:
-- docs/superpowers/plans/portal/2026-11-21-portal-registration-options-w10-entra-columns-retire.md
--
-- Drops:
--   - portal_users.entra_oid and portal_users.entra_tenant_id;
--   - their partial unique index portal_users_entra_identity_uniq;
--   - the W2 BEFORE INSERT trigger portal_users_browser_access_fill and its
--     function breeze_portal_users_fill_browser_access().
--
-- SHIPS ONE RELEASE AFTER PR-A (2027-01-28-210000-portal-identity-final-
-- backfill.sql and the code that stopped every read and write). An instance of
-- the previous release can still run after this file applies: it names none of
-- these objects, and it passes browser_access on every insert.
--
-- PRECONDITION (plan D2): REPORT, NEVER REFUSE, NEVER REPAIR. Since release N,
-- every MSP identity removal leaves a complete legacy pair behind, so this
-- file cannot tell never-backfilled drift from a credential the MSP
-- deliberately removed:
--   - re-inserting identities could resurrect a removed credential (spec §6
--     invariant 5);
--   - refusing would stop a healthy install from booting.
-- The only drift class that lost a refusal was failed closed at the release-N
-- boundary (plan D8). Nothing has read these columns to find an account since
-- identities release B, so dropping them changes no behaviour. The per-bucket
-- counts below go to the Postgres log, and backup/PITR is the recovery path
-- for the values.
--
-- After the trigger is gone, an insert that omits browser_access fails NOT NULL
-- (23502). The column has no default: browser access is never granted by
-- default (spec §6 invariant 9). The auth_method CHECK is untouched.
--
-- WRITES NO ROWS. The diagnostic reads still elect system scope, because
-- FORCE RLS would otherwise make every count 0 while blind.
-- autoMigrate wraps this file in a transaction: no BEGIN/COMMIT.
SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE missing integer; orphan integer; mismatched integer; half integer; samples text;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'portal_users' AND column_name = 'entra_oid')
     AND EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'portal_users' AND column_name = 'entra_tenant_id') THEN
    EXECUTE $q$
      SELECT count(*) FROM public.portal_users pu
       WHERE pu.entra_oid IS NOT NULL AND pu.entra_tenant_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM public.portal_user_identities i
                          WHERE i.portal_user_id = pu.id AND i.provider = 'entra')
    $q$ INTO missing;
    EXECUTE $q$
      SELECT count(*) FROM public.portal_user_identities i
        JOIN public.portal_users pu ON pu.id = i.portal_user_id
       WHERE i.provider = 'entra' AND pu.entra_oid IS NULL
    $q$ INTO orphan;
    EXECUTE $q$
      SELECT count(*) FROM public.portal_user_identities i
        JOIN public.portal_users pu ON pu.id = i.portal_user_id
       WHERE i.provider = 'entra' AND pu.entra_oid IS NOT NULL
         AND (pu.entra_oid IS DISTINCT FROM i.subject OR pu.entra_tenant_id IS DISTINCT FROM i.entra_tenant_id)
    $q$ INTO mismatched;
    EXECUTE $q$
      SELECT count(*) FROM public.portal_users WHERE (entra_oid IS NULL) <> (entra_tenant_id IS NULL)
    $q$ INTO half;
    -- Up to 20 sample ids of the rows whose pair is lost (a deliberate N-era
    -- removal, or drift), so an operator can audit them against the audit log.
    EXECUTE $q$
      SELECT string_agg(id::text, ', ') FROM (
        SELECT pu.id FROM public.portal_users pu
         WHERE pu.entra_oid IS NOT NULL AND pu.entra_tenant_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM public.portal_user_identities i
                            WHERE i.portal_user_id = pu.id AND i.provider = 'entra')
         ORDER BY pu.id LIMIT 20) s
    $q$ INTO samples;

    RAISE NOTICE 'portal_users legacy Entra columns before drop: missing_identity=% orphan_identity=% mismatched=% half_populated=% (orphan/mismatched are expected after release N)',
      missing, orphan, mismatched, half;
    IF missing > 0 THEN
      RAISE WARNING 'portal_users: dropping % legacy Entra pair(s) with no identity row (sample portal_user ids: %)', missing, samples;
    END IF;
    IF half > 0 THEN
      RAISE WARNING 'portal_users: dropping % half-populated legacy Entra row(s)', half;
    END IF;
  ELSE
    RAISE NOTICE 'portal_users legacy Entra columns already dropped (or partly): nothing to report';
  END IF;
END $$;

-- Trigger before its function.
DROP TRIGGER IF EXISTS portal_users_browser_access_fill ON public.portal_users;
DROP FUNCTION IF EXISTS public.breeze_portal_users_fill_browser_access();
DROP INDEX IF EXISTS public.portal_users_entra_identity_uniq;
ALTER TABLE public.portal_users DROP COLUMN IF EXISTS entra_oid;
ALTER TABLE public.portal_users DROP COLUMN IF EXISTS entra_tenant_id;

-- Prove it: this fires only if a DROP above silently did nothing.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'portal_users'
                AND column_name IN ('entra_oid', 'entra_tenant_id'))
     OR to_regclass('public.portal_users_entra_identity_uniq') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.portal_users'::regclass
                   AND tgname = 'portal_users_browser_access_fill')
     OR to_regprocedure('public.breeze_portal_users_fill_browser_access()') IS NOT NULL THEN
    RAISE EXCEPTION 'portal_users legacy Entra objects survived the drop';
  END IF;
END $$;
