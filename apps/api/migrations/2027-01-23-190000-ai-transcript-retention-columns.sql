-- #4342 W4 (feature #11586): AI transcript retention, columns and stub FKs.
--
-- 1. ai_data_policies.transcript_retention_days: the technician-AI transcript
--    window. Same semantics as tool_output_retention_days: on a PARTNER row
--    it is the ceiling (NULL = keep forever); on an ORG row it may only
--    tighten (NULL = inherit). With no partner row the code default (365)
--    applies.
--    Existing partner rows are backfilled to 365 in the SAME guarded block
--    that adds the column (plan correction 10): a partner row reads "its
--    value", so leaving NULL would silently mean "keep forever" for every
--    partner that ever saved the tool-output setting, while partners with no
--    row get 365. The backfill runs only when the column is first added, so a
--    partner's later choice of NULL is never overwritten on re-apply.
-- 2. ai_sessions.transcript_purged_at: set when the retention job turns a
--    session into a stub (content removed, including flag_reason; accounting
--    metadata and flagged_at/flagged_by kept).
-- 3. ai_action_plans.session_id and ai_screenshots.session_id: NO ACTION ->
--    ON DELETE CASCADE, so a stub can be hard-deleted. Site topology cleanup
--    and org erasure already remove both children first, and device deletion
--    removes the plans first; device deletion deletes ai_sessions before
--    ai_screenshots, so a device whose sessions have screenshots, which
--    failed with 23503 before, now deletes them with the session.
--
-- Writes rows (the partner backfill), so system scope is elected first.
-- Idempotent: the column adds are guarded, the CHECK is added only if
-- missing, and the FK block drops a non-canonical/non-CASCADE constraint
-- before adding the canonical one (2026-11-01-100000 pattern).

SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE
  n integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'ai_data_policies'
       AND column_name = 'transcript_retention_days'
  ) THEN
    ALTER TABLE public.ai_data_policies ADD COLUMN transcript_retention_days integer;
    UPDATE public.ai_data_policies
       SET transcript_retention_days = 365
     WHERE org_id IS NULL AND partner_id IS NOT NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN
      RAISE WARNING 'ai_data_policies: backfilled transcript_retention_days = 365 on % partner rows', n;
    END IF;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_data_policies_transcript_retention_chk') THEN
    ALTER TABLE public.ai_data_policies
      ADD CONSTRAINT ai_data_policies_transcript_retention_chk
      CHECK (transcript_retention_days IS NULL OR transcript_retention_days >= 1);
  END IF;
END $$;

ALTER TABLE public.ai_sessions ADD COLUMN IF NOT EXISTS transcript_purged_at timestamptz;

DO $$
DECLARE
  spec record;
  con record;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('ai_action_plans', 'session_id', 'ai_sessions', 'ai_action_plans_session_id_ai_sessions_id_fk'),
      ('ai_screenshots',  'session_id', 'ai_sessions', 'ai_screenshots_session_id_ai_sessions_id_fk')
    ) AS s(tbl, col, ref_tbl, con_name)
  LOOP
    FOR con IN
      SELECT c.conname
        FROM pg_constraint c
        JOIN pg_attribute a
          ON a.attrelid = c.conrelid
         AND a.attnum = c.conkey[1]
       WHERE c.contype = 'f'
         AND c.conrelid = format('public.%I', spec.tbl)::regclass
         AND c.confrelid = format('public.%I', spec.ref_tbl)::regclass
         AND array_length(c.conkey, 1) = 1
         AND a.attname = spec.col
         AND (c.confdeltype <> 'c' OR c.conname <> spec.con_name)
    LOOP
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', spec.tbl, con.conname);
    END LOOP;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conrelid = format('public.%I', spec.tbl)::regclass
         AND conname = spec.con_name
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES public.%I(id) ON DELETE CASCADE',
        spec.tbl, spec.con_name, spec.col, spec.ref_tbl
      );
    END IF;
  END LOOP;
END $$;
