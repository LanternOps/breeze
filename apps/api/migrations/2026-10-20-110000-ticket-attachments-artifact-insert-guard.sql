-- #5955 follow-up to #5919 (2026-10-16-192900-artifact-attachments.sql).
--
-- The artifact arm of ticket_attachments_backend_chk requires
-- (data IS NULL AND storage_key IS NULL) but deliberately does NOT require
-- artifact_id IS NOT NULL — that's not an oversight, it's load-bearing: the
-- FK is ON DELETE SET NULL so a legitimately-expired artifact leaves the row
-- in place with a null pointer and the content route answers 410 (see
-- artifactAttachments.integration.test.ts, "nulls both back-references...").
-- A plain CHECK requiring artifact_id IS NOT NULL would fire on that SET NULL
-- UPDATE too and make the 30-day retention sweeper's artifact delete fail with
-- 23514, wedging artifact retention — the exact failure mode the shipped
-- migration's comment warns against.
--
-- What the CHECK does NOT cover: an INSERT that sets storage_backend =
-- 'artifact' with artifact_id NULL from the start — a pointer that was never
-- valid, indistinguishable at read time from a legitimately-expired one but
-- never carried a byte anywhere. The one existing writer
-- (routes/tickets/attachments.ts) always sets artifact_id, so this is
-- defense-in-depth, not a live corruption: a BEFORE INSERT trigger, which
-- fires only on INSERT and never on the FK's UPDATE ... SET NULL, so it
-- can enforce "must point somewhere at creation time" without touching the
-- expiry contract above.
--
-- Idempotent; no inner BEGIN/COMMIT (autoMigrate wraps each file in a
-- transaction).

CREATE OR REPLACE FUNCTION public.breeze_guard_ticket_attachment_artifact_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NEW.storage_backend = 'artifact' AND NEW.artifact_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'ticket_attachments_artifact_insert_guard',
      MESSAGE = 'artifact-backed ticket attachment must reference an artifact on insert';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ticket_attachments_artifact_insert_guard ON public.ticket_attachments;
CREATE TRIGGER ticket_attachments_artifact_insert_guard
  BEFORE INSERT ON public.ticket_attachments
  FOR EACH ROW
  EXECUTE FUNCTION public.breeze_guard_ticket_attachment_artifact_insert();

-- Forensic count only — NOT a cleanup. A pre-existing storage_backend =
-- 'artifact' row with a NULL artifact_id is the expected steady state for an
-- artifact that already expired (kept on purpose, serves 410) and is
-- indistinguishable from a hypothetical originally-bad insert once it exists.
-- Deleting either would destroy the 410 behaviour for real expiries and
-- possibly forensic evidence for a bad one, so this only logs the count for
-- the record; it changes no rows. Needs system scope: this table is
-- FORCE ROW LEVEL SECURITY and a scopeless read silently matches zero rows
-- rather than erroring (see CLAUDE.md's migration RLS-scope guard note).
SELECT set_config('breeze.scope', 'system', true);
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM ticket_attachments
    WHERE storage_backend = 'artifact' AND artifact_id IS NULL;
  IF n > 0 THEN
    RAISE WARNING 'ticket_attachments: % pre-existing artifact-backed row(s) with a NULL artifact_id (expected for artifacts that expired before this guard shipped; left untouched, still serve 410)', n;
  END IF;
END $$;
