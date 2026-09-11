-- 2026-10-16-100000: script_versions become immutable execution definitions.
--
-- Today script_versions holds (id, script_id, version, content, changelog,
-- created_by, created_at) and is written by exactly one caller — the bundle
-- importer, as a BEFORE-image (services/scriptBundle/index.ts). Nothing can
-- say what language/timeout/run_as a past body ran under, (script_id,
-- version) is only a non-unique index, the FK to scripts has no ON DELETE
-- (so a GDPR org erasure of `scripts` would abort with 23503 the moment any
-- version row existed), and the 2026-10-01 RLS set permits UPDATE and DELETE,
-- so history is rewritable by any org that owns the script.
--
-- This migration makes a version row the complete, content-addressed
-- definition of one execution, and makes it append-only. See spec
-- docs/superpowers/specs/ai-mcp/2026-09-11-ai-script-authoring-and-review-design.md §4.1.
--
-- Order inside the file matters:
--   enum -> columns -> approved_by FK -> duplicate repair -> column backfill
--   -> NOT NULL -> head backfill -> unique -> parent FK swap -> policy drop
--   -> immutability trigger (LAST: it would abort the backfill UPDATEs above).
--
-- Writes rows, so breeze.scope is elected first: breeze_current_scope()
-- defaults to 'none' and script_versions is FORCE ROW LEVEL SECURITY, which
-- binds the owner too — without this the UPDATEs below match zero rows in
-- silence on managed Postgres and the INSERT aborts with 42501.
-- is_local = true scopes it to autoMigrate's per-file transaction.
-- autoMigrate wraps each file in a transaction — no inner BEGIN/COMMIT.
SELECT set_config('breeze.scope', 'system', true);

DO $$
BEGIN
  CREATE TYPE public.script_origin AS ENUM ('human', 'ai_proposal', 'imported', 'system');
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

ALTER TABLE public.script_versions
  ADD COLUMN IF NOT EXISTS language         public.script_language,
  ADD COLUMN IF NOT EXISTS timeout_seconds  integer,
  ADD COLUMN IF NOT EXISTS run_as           public.script_run_as,
  ADD COLUMN IF NOT EXISTS parameters       jsonb,
  ADD COLUMN IF NOT EXISTS content_digest   char(64),
  ADD COLUMN IF NOT EXISTS origin           public.script_origin NOT NULL DEFAULT 'human',
  ADD COLUMN IF NOT EXISTS proposal_id      uuid,
  ADD COLUMN IF NOT EXISTS review_id        uuid,
  ADD COLUMN IF NOT EXISTS reviewed_at      timestamp,
  ADD COLUMN IF NOT EXISTS approved_by      uuid,
  ADD COLUMN IF NOT EXISTS approved_at      timestamp,
  ADD COLUMN IF NOT EXISTS approval_method  text;

-- proposal_id / review_id are deliberately BARE uuids, not FKs: the referenced
-- rows are org-scoped and left for erasure on a merge (spec §5), so a hard FK
-- would either block erasure or drag version history with it.
DO $$
BEGIN
  ALTER TABLE public.script_versions
    ADD CONSTRAINT script_versions_approved_by_users_id_fk
    FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

-- Repair before UNIQUE. Keep the oldest row in each (script_id, version)
-- group at its number and renumber the rest above the script's current max,
-- preserving history rather than deleting it. Counts are RAISEd even at zero:
-- a 0 here is the evidence that production had no duplicates, which the plan
-- (spec §10) explicitly asks to record.
DO $$
DECLARE
  dup_groups bigint;
  renumbered bigint;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  SELECT count(*) INTO dup_groups
  FROM (
    SELECT script_id, version
    FROM public.script_versions
    GROUP BY script_id, version
    HAVING count(*) > 1
  ) d;
  RAISE WARNING 'script_versions: % duplicate (script_id, version) group(s) found', dup_groups;

  WITH ranked AS (
    SELECT id, script_id,
           row_number() OVER (PARTITION BY script_id, version ORDER BY created_at, id) AS rn
    FROM public.script_versions
  ),
  maxv AS (
    SELECT script_id, max(version) AS mv
    FROM public.script_versions
    GROUP BY script_id
  ),
  targets AS (
    SELECT r.id,
           m.mv + (row_number() OVER (PARTITION BY r.script_id ORDER BY r.id))::integer AS new_version
    FROM ranked r
    JOIN maxv m ON m.script_id = r.script_id
    WHERE r.rn > 1
  )
  UPDATE public.script_versions v
  SET version = t.new_version
  FROM targets t
  WHERE v.id = t.id;
  GET DIAGNOSTICS renumbered = ROW_COUNT;
  RAISE WARNING 'script_versions: renumbered % duplicate row(s)', renumbered;
END $$;

-- Existing rows predate the definition columns. Their language/timeout/run_as
-- are unrecoverable for the body they hold, so they inherit the parent
-- script's CURRENT values — the honest best available, and the only rows this
-- ever applies to are bundle before-images. content_digest is derived from the
-- row's own content under the canonical form the TS helper uses
-- (services/scriptVersions.ts sha256Content): NFC, CRLF -> LF, no trimming.
DO $$
DECLARE
  filled bigint;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  UPDATE public.script_versions v
  SET language        = COALESCE(v.language, s.language),
      timeout_seconds = COALESCE(v.timeout_seconds, s.timeout_seconds),
      run_as          = COALESCE(v.run_as, s.run_as),
      parameters      = COALESCE(v.parameters, s.parameters),
      content_digest  = COALESCE(
        v.content_digest,
        encode(sha256(convert_to(normalize(replace(v.content, E'\r\n', E'\n'), NFC), 'UTF8')), 'hex')
      ),
      origin          = CASE WHEN s.is_system THEN 'system' ELSE 'human' END::public.script_origin
  FROM public.scripts s
  WHERE s.id = v.script_id
    AND (v.language IS NULL
      OR v.timeout_seconds IS NULL
      OR v.run_as IS NULL
      OR v.content_digest IS NULL);
  GET DIAGNOSTICS filled = ROW_COUNT;
  RAISE WARNING 'script_versions: backfilled definition columns on % pre-existing row(s)', filled;
END $$;

ALTER TABLE public.script_versions ALTER COLUMN language        SET NOT NULL;
ALTER TABLE public.script_versions ALTER COLUMN timeout_seconds SET NOT NULL;
ALTER TABLE public.script_versions ALTER COLUMN run_as          SET NOT NULL;
ALTER TABLE public.script_versions ALTER COLUMN content_digest  SET NOT NULL;

-- One version row per script whose CURRENT scripts.version has no row. Every
-- script predating this migration has none, so this is the row that makes
-- headScriptVersion() answerable for the whole existing library.
DO $$
DECLARE
  inserted bigint;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  INSERT INTO public.script_versions
    (script_id, version, content, language, timeout_seconds, run_as, parameters,
     content_digest, origin, changelog, created_by, created_at)
  SELECT s.id, s.version, s.content, s.language, s.timeout_seconds, s.run_as, s.parameters,
         encode(sha256(convert_to(normalize(replace(s.content, E'\r\n', E'\n'), NFC), 'UTF8')), 'hex'),
         CASE WHEN s.is_system THEN 'system' ELSE 'human' END::public.script_origin,
         'Backfilled head version (2026-10-16-100000)',
         s.created_by,
         s.created_at
  FROM public.scripts s
  WHERE NOT EXISTS (
    SELECT 1 FROM public.script_versions v
    WHERE v.script_id = s.id AND v.version = s.version
  );
  GET DIAGNOSTICS inserted = ROW_COUNT;
  RAISE WARNING 'script_versions: backfilled % head version row(s)', inserted;
END $$;

-- UNIQUE replaces the non-unique index (0001-baseline.sql). Drop the index
-- first: the constraint's own index covers the same (script_id, version)
-- lookups, so keeping both would only duplicate write cost.
DROP INDEX IF EXISTS public.script_versions_script_id_version_idx;

DO $$
BEGIN
  ALTER TABLE public.script_versions
    ADD CONSTRAINT script_versions_script_id_version_key UNIQUE (script_id, version);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN
  NULL;
END $$;

-- The baseline FK has no ON DELETE, so it defaults to NO ACTION and a
-- `DELETE FROM scripts WHERE org_id = $1` during org erasure aborts with 23503
-- as soon as any version row exists. CASCADE is how a table with no org_id of
-- its own erases with its tenant (spec §5). Referential actions run with
-- force-RLS disabled, so the cascade still fires under the INSERT+SELECT-only
-- policy set installed below.
ALTER TABLE public.script_versions
  DROP CONSTRAINT IF EXISTS script_versions_script_id_scripts_id_fk;

DO $$
BEGIN
  ALTER TABLE public.script_versions
    ADD CONSTRAINT script_versions_script_id_scripts_id_fk
    FOREIGN KEY (script_id) REFERENCES public.scripts(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

-- Reduce RLS to INSERT + SELECT. The SELECT and INSERT policies installed by
-- 2026-10-01-100000-script-children-rls.sql are correct and are LEFT AS THEY
-- ARE; only the UPDATE and DELETE policies go. With no policy for a command,
-- FORCE ROW LEVEL SECURITY denies it for every role including the owner and
-- system scope — which is the point: version history is append-only, and rows
-- die only through the parent FK above.
--
-- IF EXISTS makes this idempotent, which is the pg_policies existence check in
-- statement form; a second run drops nothing and raises nothing.
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.script_versions;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.script_versions;

-- Backstop for the paths RLS does not bind: a future migration, a replication
-- apply, or anyone connecting as a BYPASSRLS/superuser role. Fires on UPDATE
-- only — DELETE must stay possible for the FK cascade.
CREATE OR REPLACE FUNCTION public.breeze_script_versions_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'script_versions rows are immutable (id=%); cut a new version instead', OLD.id
    USING ERRCODE = '42501';
END;
$fn$;

DROP TRIGGER IF EXISTS script_versions_immutable ON public.script_versions;
CREATE TRIGGER script_versions_immutable
  BEFORE UPDATE ON public.script_versions
  FOR EACH ROW EXECUTE FUNCTION public.breeze_script_versions_immutable();
