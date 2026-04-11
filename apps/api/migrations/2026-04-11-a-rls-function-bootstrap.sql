-- 2026-04-11: RLS helper-function and column bootstrap.
--
-- Why this file exists, and why it sorts first among the 2026-04-11
-- migration group:
--
--   The 2026-04-11 RLS work was developed incrementally against a dev
--   database and shipped as many small files. On dev they were applied
--   in *creation* order (each merge timestamp), so cross-file
--   dependencies never surfaced. But autoMigrate applies migrations in
--   *alphabetical* order, and on a fresh install (new self-hosted user,
--   prod container on first boot) the alphabetical ordering violates
--   three real dependencies:
--
--     bucket-c-phase-6-user-scoped-rls.sql  →  references
--       public.breeze_current_user_id()        (defined in users-rls.sql)
--       public.breeze_has_partner_access(uuid) (defined in partners-rls.sql)
--       users.partner_id / users.org_id        (added in users-rls.sql)
--
--     bucket-c-sessions-rls.sql              →  references
--       public.breeze_current_user_id()        (defined in users-rls.sql)
--
--   Both consumer files sort BEFORE both producer files ("bucket" < "u",
--   "bucket" < "p"), so CREATE POLICY would fail at parse time with
--   "function does not exist" or "column does not exist".
--
--   This bootstrap file sorts BEFORE every 2026-04-11 file because of the
--   single-character "-a-" segment ("a" < "b" of "bucket", "c" of
--   "cis", "d" of "device", "o" of "organizations", "p" of "partners",
--   "r" of "rewrite"/"roles", "u" of "users"). It pre-creates the three
--   dependencies in idempotent form. When users-rls.sql and partners-rls.sql
--   later run, their CREATE OR REPLACE FUNCTION and ADD COLUMN IF NOT EXISTS
--   statements are no-ops against the objects already created here, so the
--   behavior on dev (where this file is new and applies after everything
--   else) is identical to the behavior on a fresh install.
--
--   DO NOT edit the function bodies here without editing the originating
--   migration files in lockstep. The two definitions are required to be
--   byte-identical so CREATE OR REPLACE is a true no-op and downstream
--   policies see the same semantics regardless of which file applied last.
--
-- Fully idempotent — safe to re-run.

BEGIN;

-- ============================================================
-- 1. breeze_current_user_id() — verbatim from users-rls.sql.
--    Reads breeze.user_id GUC, casts to uuid, returns NULL when unset.
-- ============================================================
CREATE OR REPLACE FUNCTION public.breeze_current_user_id()
  RETURNS uuid
  LANGUAGE sql
  STABLE
AS $function$
  SELECT NULLIF(current_setting('breeze.user_id', true), '')::uuid;
$function$;

-- ============================================================
-- 2. users.partner_id and users.org_id — verbatim from users-rls.sql.
--    Added nullable here so CREATE POLICY in phase-6 can reference them.
--    users-rls.sql later backfills and (on the one-time migration path)
--    sets partner_id NOT NULL. On fresh install the users table is empty
--    when that runs so SET NOT NULL is a no-op.
-- ============================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS partner_id uuid;
ALTER TABLE users ADD COLUMN IF NOT EXISTS org_id uuid;

-- ============================================================
-- 3. breeze_accessible_partner_ids() — verbatim from partners-rls.sql.
--    Reads the breeze.accessible_partner_ids GUC, fail-closed on
--    malformed values.
-- ============================================================
CREATE OR REPLACE FUNCTION public.breeze_accessible_partner_ids()
  RETURNS uuid[]
  LANGUAGE plpgsql
  STABLE
AS $function$
DECLARE
  raw text;
BEGIN
  raw := current_setting('breeze.accessible_partner_ids', true);

  -- "*" means unrestricted partner access (system scope).
  IF raw = '*' THEN
    RETURN NULL;
  END IF;

  -- Empty/missing means no partner access.
  IF raw IS NULL OR raw = '' THEN
    RETURN ARRAY[]::uuid[];
  END IF;

  RETURN string_to_array(raw, ',')::uuid[];
EXCEPTION
  WHEN others THEN
    -- Fail closed on malformed values.
    RETURN ARRAY[]::uuid[];
END;
$function$;

-- ============================================================
-- 4. breeze_has_partner_access() — verbatim from partners-rls.sql.
--    Depends on breeze_current_scope() from 0008-tenant-rls.sql, which
--    is always available on any DB that has ever run migrations.
-- ============================================================
CREATE OR REPLACE FUNCTION public.breeze_has_partner_access(target_partner_id uuid)
  RETURNS boolean
  LANGUAGE sql
  STABLE
AS $function$
  SELECT CASE
    WHEN public.breeze_current_scope() = 'system' THEN TRUE
    WHEN target_partner_id IS NULL THEN FALSE
    ELSE COALESCE(target_partner_id = ANY(public.breeze_accessible_partner_ids()), FALSE)
  END;
$function$;

COMMIT;
