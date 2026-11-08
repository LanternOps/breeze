-- Portal registration W2 (#11379): account foundations. Spec:
-- docs/superpowers/specs/portal/2026-11-07-portal-registration-options-design.md §5.1, §5.2.
--
--   1. portal_users.status       → CHECK (invited | active | disabled)
--   2. portal_users.browser_access (granted | none) — backfilled, NOT NULL,
--      filled by a BEFORE INSERT trigger when a writer omits it
--   3. UNIQUE (id, org_id) on portal_users (composite-FK target)
--   4. portal_user_identities (tenancy shape 1, RLS in this same file)
--   5. identities release A backfill from portal_users.entra_*
--
-- Nothing changes for anyone on deploy: every password login is backfilled
-- 'granted' (the session middleware already requires auth_method='password'),
-- every Entra (AI for Office) login 'none' (it never had browser access).
--
-- WRITES ROWS → system scope first (forced RLS binds the migration role).
-- autoMigrate wraps this file in a transaction: no BEGIN/COMMIT.
-- portal_users carries no partner-export triggers, so no pre-locks are needed.
SELECT set_config('breeze.scope', 'system', true);

-- 1. status: fail closed, then CHECK. Every known writer writes
--    invited|active|disabled. Anything else (no writer produces one) becomes
--    'disabled' with an epoch bump: such a row is already refused by login and
--    the session gate (status <> 'active'), and mapping a near-miss such as
--    ' Active ' back to 'active' would grant access without review.
DO $$
DECLARE n integer; r record;
BEGIN
  FOR r IN SELECT status, count(*) AS c FROM public.portal_users
            WHERE status NOT IN ('invited','active','disabled')
            GROUP BY status ORDER BY status LOOP
    RAISE WARNING 'portal_users: unknown status % on % row(s) -> disabled', quote_literal(r.status), r.c;
  END LOOP;

  UPDATE public.portal_users
     SET status = 'disabled', auth_epoch = auth_epoch + 1, updated_at = now()
   WHERE status NOT IN ('invited','active','disabled');
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'portal_users: disabled % row(s) with an unknown status', n;
  ELSE RAISE NOTICE 'portal_users: disabled 0 row(s) with an unknown status'; END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.portal_users'::regclass AND conname = 'portal_users_status_chk') THEN
    ALTER TABLE public.portal_users
      ADD CONSTRAINT portal_users_status_chk CHECK (status IN ('invited','active','disabled'));
  END IF;
END $$;

-- 2. browser_access: add nullable, backfill only NULLs (a replay never resets a
--    later grant or revoke), install the fill trigger for writers that omit the
--    column (an older API binary during a rolling deploy), then NOT NULL + CHECK.
--    Deliberately NO column default: DEFAULT 'granted' would grant browser
--    access to add-in JIT rows written by an old binary, DEFAULT 'none' would
--    break invites written by one. The trigger exists only for API binaries
--    older than this release; drop it in a follow-up migration once none can
--    run (scheduled with identities release C, which drops portal_users.entra_*).
ALTER TABLE public.portal_users ADD COLUMN IF NOT EXISTS browser_access text;

DO $$
DECLARE g integer; nn integer;
BEGIN
  UPDATE public.portal_users SET browser_access = 'granted'
   WHERE browser_access IS NULL AND auth_method = 'password';
  GET DIAGNOSTICS g = ROW_COUNT;
  UPDATE public.portal_users SET browser_access = 'none'
   WHERE browser_access IS NULL AND auth_method <> 'password';
  GET DIAGNOSTICS nn = ROW_COUNT;
  RAISE NOTICE 'portal_users: browser_access backfilled granted=% none=%', g, nn;
END $$;

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

ALTER TABLE public.portal_users ALTER COLUMN browser_access SET NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.portal_users'::regclass AND conname = 'portal_users_browser_access_chk') THEN
    ALTER TABLE public.portal_users
      ADD CONSTRAINT portal_users_browser_access_chk CHECK (browser_access IN ('granted','none'));
  END IF;
END $$;

-- 3. Composite-FK target for portal_user_identities.
CREATE UNIQUE INDEX IF NOT EXISTS portal_users_id_org_uq ON public.portal_users (id, org_id);

-- 4. portal_user_identities — tenancy shape 1 (direct org_id), RLS in this
--    same migration. The single source of truth for external identity from
--    identities release B on; in release A (this wave) only the AI for Office
--    exchange dual-writes it and nothing reads it for authorization.
CREATE TABLE IF NOT EXISTS public.portal_user_identities (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  portal_user_id  uuid NOT NULL,
  provider        text NOT NULL,
  issuer          text NOT NULL,
  subject         text NOT NULL,
  entra_tenant_id text,
  linked_via      text NOT NULL,
  last_used_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- An identity's org always equals its account's org (spec §6 invariant 4).
  -- DEFERRABLE INITIALLY IMMEDIATE so org merge can re-tenant both rows.
  CONSTRAINT portal_user_identities_user_org_fk
    FOREIGN KEY (portal_user_id, org_id) REFERENCES public.portal_users (id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT portal_user_identities_provider_chk CHECK (provider IN ('entra','google')),
  CONSTRAINT portal_user_identities_linked_via_chk
    CHECK (linked_via IN ('jit','invite','self_link','scim','migrated','msp')),
  CONSTRAINT portal_user_identities_entra_tenant_chk
    CHECK ((provider = 'entra') = (entra_tenant_id IS NOT NULL)),
  CONSTRAINT portal_user_identities_issuer_chk CHECK (
    (provider = 'entra'  AND issuer = 'https://login.microsoftonline.com/' || entra_tenant_id || '/v2.0')
 OR (provider = 'google' AND issuer = 'https://accounts.google.com'))
);
CREATE UNIQUE INDEX IF NOT EXISTS portal_user_identities_issuer_subject_uq ON public.portal_user_identities (issuer, subject);
CREATE UNIQUE INDEX IF NOT EXISTS portal_user_identities_user_provider_uq ON public.portal_user_identities (portal_user_id, provider);
CREATE INDEX IF NOT EXISTS portal_user_identities_org_id_idx ON public.portal_user_identities (org_id);

ALTER TABLE public.portal_user_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portal_user_identities FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON public.portal_user_identities;
CREATE POLICY breeze_org_isolation_select ON public.portal_user_identities
  FOR SELECT USING (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.portal_user_identities;
CREATE POLICY breeze_org_isolation_insert ON public.portal_user_identities
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.portal_user_identities;
CREATE POLICY breeze_org_isolation_update ON public.portal_user_identities
  FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.portal_user_identities;
CREATE POLICY breeze_org_isolation_delete ON public.portal_user_identities
  FOR DELETE USING (public.breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON public.portal_user_identities TO breeze_app;

-- 5. Backfill from portal_users.entra_* (release A). ON CONFLICT with no target
--    covers both unique keys, so a replay inserts nothing.
DO $$
DECLARE n integer; half integer;
BEGIN
  INSERT INTO public.portal_user_identities
    (org_id, portal_user_id, provider, issuer, subject, entra_tenant_id, linked_via, last_used_at, created_at)
  SELECT pu.org_id, pu.id, 'entra',
         'https://login.microsoftonline.com/' || pu.entra_tenant_id || '/v2.0',
         pu.entra_oid, pu.entra_tenant_id, 'migrated', pu.last_login_at, pu.created_at
    FROM public.portal_users pu
   WHERE pu.entra_oid IS NOT NULL AND pu.entra_tenant_id IS NOT NULL
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'portal_user_identities: backfilled % entra identit(ies)', n;

  SELECT count(*) INTO half FROM public.portal_users
   WHERE (entra_oid IS NULL) <> (entra_tenant_id IS NULL);
  IF half > 0 THEN
    RAISE WARNING 'portal_users: % row(s) have only one of entra_oid/entra_tenant_id — not backfilled', half;
  END IF;
END $$;
