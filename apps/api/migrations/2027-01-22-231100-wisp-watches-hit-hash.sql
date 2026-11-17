-- #11424 — Wisp watches remember what they last saw.
--
-- Before these columns a watch was only a timer: every cadence the wake
-- scheduler (jobs/wispWakeScheduler.ts) launched a full model run for it,
-- whether or not anything had changed. The scheduler now evaluates the watch in
-- code at claim time (services/wisp/watchHits.ts) and launches a run only when
-- the hit-set differs from the one recorded here.
--
--   hit_hash  — sha256 (hex) of the sorted hit-set of the last evaluation a
--               run was queued for. NULL = never recorded: the next
--               evaluation launches a run ("first evaluation").
--   hit_count — how many hits that evaluation found.
--
-- Nullable, no backfill and no row writes: every existing watch starts NULL,
-- so its next evaluation runs once, as it does today. Both columns are
-- non-sensitive scalars (classified `included` in the tenant export policy).
ALTER TABLE wisp_watches ADD COLUMN IF NOT EXISTS hit_hash text;
ALTER TABLE wisp_watches ADD COLUMN IF NOT EXISTS hit_count integer;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wisp_watches_hit_count_chk') THEN
    ALTER TABLE wisp_watches
      ADD CONSTRAINT wisp_watches_hit_count_chk CHECK (hit_count IS NULL OR hit_count >= 0);
  END IF;
END $$;
