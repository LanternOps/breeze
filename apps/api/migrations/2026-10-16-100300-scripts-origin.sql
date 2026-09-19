-- scripts gains birth provenance (spec §4.1). `origin` is the RECORD's birth;
-- a human edit after promotion cuts a new head version with origin = human and
-- empty review fields, which is what makes the library badge honestly drop to
-- "edited since review".
--
-- THIS FILE WRITES ROWS (the is_system backfill), so it elects system scope
-- first: breeze_current_scope() defaults to 'none' and `scripts` is FORCE ROW
-- LEVEL SECURITY, which binds the table owner too — without the elevation the
-- UPDATE matches zero rows silently and the RAISE WARNING prints a truthful-
-- looking 0.
--
-- `script_origin` is created by 2026-10-16-100000-script-versions-immutable.sql.
-- It is re-declared here in the same idempotent form so this file also applies
-- on a database where that file has not run (a cherry-picked branch, a partial
-- restore) rather than failing on an undefined type.

SELECT set_config('breeze.scope', 'system', true);

DO $$ BEGIN
  CREATE TYPE script_origin AS ENUM ('human','ai_proposal','imported','system');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE scripts ADD COLUMN IF NOT EXISTS origin script_origin NOT NULL DEFAULT 'human';
-- Bare uuid: the proposal is org-scoped incident data that may be erased long
-- before the promoted script is, and the UI renders "review evidence erased"
-- rather than following a broken link (spec §4.8).
ALTER TABLE scripts ADD COLUMN IF NOT EXISTS origin_proposal_id UUID;

DO $$
DECLARE n integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  UPDATE scripts SET origin = 'system' WHERE is_system IS TRUE AND origin <> 'system';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'backfilled origin=system on % built-in script(s)', n;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS scripts_origin_idx ON scripts (org_id, origin);
