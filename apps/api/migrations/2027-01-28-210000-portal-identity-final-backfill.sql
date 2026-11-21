-- Portal registration W10 (#11387), identities release C, PR-A (plan D3):
-- the FINAL identity backfill, at the release-N boundary. Data only — no DDL.
-- Plan: docs/superpowers/plans/portal/2026-11-21-portal-registration-options-w10-entra-columns-retire.md
--
-- From this release on nothing reads or writes portal_users.entra_oid /
-- entra_tenant_id (the W3 D4 writer fence is gone), so the legacy unique index
-- portal_users_entra_identity_uniq no longer refuses a second login for a
-- (tid, oid) whose identity row is missing. Only the identity key
-- (issuer, subject) does. A legacy pair with no identity row would therefore
-- let the add-in exchange mint a NEW active login for that person, even when
-- the original account is disabled.
--
-- At this instant every such row is never-backfilled drift, never a deliberate
-- removal. Every identity remover shipped through v0.130
-- (portalDirectory/identityDisable.removeDisabledPortalIdentity) cleared the
-- columns in the same transaction, so re-inserting cannot resurrect a removed
-- credential. That stops being true once release-N code runs (it no longer
-- clears them), which is why the drop migration one release later only REPORTS
-- (plan D2). The insert is the release-A / release-B one
-- (2027-01-22-230200 §5, 2027-01-22-232800 §4). ON CONFLICT with no target
-- covers both unique keys, so a replay inserts nothing.
--
-- WRITES ROWS → system scope first (forced RLS binds the migration role).
-- autoMigrate wraps this file in a transaction: no BEGIN/COMMIT.
-- portal_user_identities carries no partner-export triggers, so no pre-locks.
SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE n integer; still_missing integer; mismatched integer; half integer;
BEGIN
  -- A database that already ran the drop (PR-B) replays nothing here.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'portal_users' AND column_name = 'entra_oid')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'portal_users' AND column_name = 'entra_tenant_id') THEN
    RAISE NOTICE 'portal_user_identities: final backfill skipped (portal_users.entra_* already dropped)';
    RETURN;
  END IF;

  EXECUTE $q$
    INSERT INTO public.portal_user_identities
      (org_id, portal_user_id, provider, issuer, subject, entra_tenant_id, linked_via, last_used_at, created_at)
    SELECT pu.org_id, pu.id, 'entra',
           'https://login.microsoftonline.com/' || pu.entra_tenant_id || '/v2.0',
           pu.entra_oid, pu.entra_tenant_id, 'migrated', pu.last_login_at, pu.created_at
      FROM public.portal_users pu
     WHERE pu.entra_oid IS NOT NULL AND pu.entra_tenant_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.portal_user_identities i
                        WHERE i.portal_user_id = pu.id AND i.provider = 'entra')
    ON CONFLICT DO NOTHING
  $q$;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'portal_user_identities: final backfill inserted % identit(ies) for legacy pairs that had none', n;
  ELSE
    RAISE NOTICE 'portal_user_identities: final backfill inserted 0 identities';
  END IF;

  -- What the backfill cannot repair, counted for the operator (never refused).
  -- A pair still without an identity: its (issuer, subject) belongs to another login.
  EXECUTE $q$
    SELECT count(*) FROM public.portal_users pu
     WHERE pu.entra_oid IS NOT NULL AND pu.entra_tenant_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.portal_user_identities i
                        WHERE i.portal_user_id = pu.id AND i.provider = 'entra')
  $q$ INTO still_missing;
  EXECUTE $q$
    SELECT count(*) FROM public.portal_users pu
      JOIN public.portal_user_identities i ON i.portal_user_id = pu.id AND i.provider = 'entra'
     WHERE pu.entra_oid IS NOT NULL
       AND (pu.entra_oid IS DISTINCT FROM i.subject OR pu.entra_tenant_id IS DISTINCT FROM i.entra_tenant_id)
  $q$ INTO mismatched;
  EXECUTE $q$
    SELECT count(*) FROM public.portal_users WHERE (entra_oid IS NULL) <> (entra_tenant_id IS NULL)
  $q$ INTO half;
  IF still_missing > 0 THEN
    RAISE WARNING 'portal_users: % legacy Entra pair(s) still have no identity (their issuer/subject is linked to another login)', still_missing;
  END IF;
  IF mismatched > 0 THEN
    RAISE WARNING 'portal_users: % legacy Entra pair(s) disagree with the account''s identity (the identity wins)', mismatched;
  END IF;
  IF half > 0 THEN
    RAISE WARNING 'portal_users: % row(s) have only one of entra_oid/entra_tenant_id (never backfilled)', half;
  END IF;
END $$;
