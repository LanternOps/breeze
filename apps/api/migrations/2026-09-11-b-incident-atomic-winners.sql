-- AI agents wave 3.5a (#3825): give the incident background passes something
-- atomic to compare-and-swap on.
--
-- Both unsafe passes record their own completion INSIDE the `timeline` jsonb
-- array and gate on reading it back:
--
--   * the enricher (jobs/incidentJobs.ts) selects with
--     NOT (timeline::jsonb @> '[{"type":"timeline_enriched"}]'::jsonb)
--     and then appends a timeline_enriched entry;
--   * the SLA monitor computes alreadyEscalated from
--     timeline.some(e => e.type === 'incident_escalated')
--     and then appends an incident_escalated entry.
--
-- Read-array-then-append is check-then-act: two processes read the same
-- un-marked array and both append. Today one process runs, so it is latent.
-- The wave-3.5d role split makes it real, and a duplicate escalation publishes
-- incident.escalated twice — i.e. pages on-call twice.
--
-- `timeline` is also a RENDERING surface: keeping control state in it means the
-- display format and the concurrency control are the same field. Separate them.
-- The timeline entries stay exactly as they are; these columns are what the
-- passes actually gate on.

ALTER TABLE incidents ADD COLUMN IF NOT EXISTS timeline_enriched_at timestamptz;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS escalated_at timestamptz;

-- Backfill from the existing timeline markers so incidents already processed
-- are not re-enriched or re-escalated the first time the new code runs.
-- Report the counts: a surprising number here means the timeline markers and
-- reality disagree, which is worth knowing before trusting the new columns.
DO $$
DECLARE
  enriched integer;
  escalated integer;
BEGIN
  UPDATE incidents SET timeline_enriched_at = updated_at
  WHERE timeline_enriched_at IS NULL
    AND timeline::jsonb @> '[{"type":"timeline_enriched"}]'::jsonb;
  GET DIAGNOSTICS enriched = ROW_COUNT;

  UPDATE incidents SET escalated_at = updated_at
  WHERE escalated_at IS NULL
    AND timeline::jsonb @> '[{"type":"incident_escalated"}]'::jsonb;
  GET DIAGNOSTICS escalated = ROW_COUNT;

  IF enriched > 0 OR escalated > 0 THEN
    RAISE WARNING 'wave 3.5a: backfilled % enriched / % escalated incident marker(s)', enriched, escalated;
  END IF;
END $$;

-- Both passes scan for the NULL side only, so index that side.
CREATE INDEX IF NOT EXISTS incidents_timeline_unenriched_idx
  ON incidents (id) WHERE timeline_enriched_at IS NULL;
CREATE INDEX IF NOT EXISTS incidents_unescalated_idx
  ON incidents (id) WHERE escalated_at IS NULL;
