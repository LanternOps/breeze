-- #10386: Wisp's readiness notes get a subject kind of their own.
--
-- The onboarding readiness note ("I can watch alerts… I can't watch tickets")
-- and the no-agent note were raised with subject (org, <org id>), the same
-- one-live-concern slot (wisp_concerns_live_subject_uq) a real org-level
-- concern uses. upsertConcern then handed the model's org concern back as if
-- it were the note, and the note's summary + evidence replaced it (severity
-- stayed HIGH); the other way round, a note holding the slot swallowed later
-- org-level raises. From now on both notes use subject ('readiness', <org id>).
--
-- Idempotent: the CHECK is dropped and re-added, and every UPDATE matches only
-- rows still in the old shape.

SELECT set_config('breeze.scope', 'system', true);

ALTER TABLE wisp_concerns DROP CONSTRAINT IF EXISTS wisp_concerns_subject_kind_chk;
ALTER TABLE wisp_concerns ADD CONSTRAINT wisp_concerns_subject_kind_chk CHECK (subject_kind IN (
  'ticket','device','alert','org','integration','run','task','incident','quote','invoice','contract','site','readiness'
));

DO $$
DECLARE n integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  -- 1. Readiness notes stored under the org subject move to their own kind.
  --    Exact org-derived signatures only (assessmentFinalizer.applyReadiness,
  --    wisp/assessment.noAgentSignature). At most one of them is live per org
  --    (they shared the org slot), so the move cannot collide.
  UPDATE wisp_concerns
     SET subject_kind = 'readiness', updated_at = now()
   WHERE subject_kind = 'org'
     AND org_id IS NOT NULL
     AND subject_id = org_id
     AND (signature = 'readiness:' || org_id::text
          OR signature = 'wisp-readiness:no-effective-agent:' || org_id::text);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING '#10386: moved % readiness concern(s) to subject kind readiness', n; END IF;

  -- 2. Model-raised org concerns the readiness note overwrote: no signature,
  --    evidence is exactly the note's { readiness: { checks, missingIntegrations } }
  --    and the summary is the note's rendered text. Their original summary and
  --    evidence are gone, so they are resolved (not converted): the next
  --    assessment re-raises whatever is still wrong.
  UPDATE wisp_concerns
     SET status = 'resolved',
         outcome = 'Closed by migration (#10386): the onboarding readiness note overwrote this concern''s summary and evidence. The next assessment re-raises it if it still applies.',
         resolved_at = now(),
         updated_at = now()
   WHERE status IN ('open','snoozed')
     AND subject_kind = 'org'
     AND org_id IS NOT NULL
     AND subject_id = org_id
     AND signature IS NULL
     AND jsonb_typeof(evidence -> 'readiness') = 'object'
     AND (evidence - 'readiness') = '{}'::jsonb
     AND jsonb_typeof(evidence -> 'readiness' -> 'checks') = 'array'
     AND (evidence -> 'readiness') ? 'missingIntegrations'
     AND (summary LIKE 'I can watch %' OR summary LIKE 'There is nothing here I can watch yet.%');
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING '#10386: resolved % org concern(s) overwritten by the readiness note', n; END IF;
END $$;
