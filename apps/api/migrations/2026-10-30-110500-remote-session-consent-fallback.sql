-- #6819: bind the consent-unavailable fallback to the desktop start generation.
--
-- A consent-mode start whose consent could not be solicited (no consent-capable
-- helper: `helper_absent`; the prompt went unanswered: `timeout`) proceeds only
-- when the org's policy says consentUnavailableBehavior = 'proceed'. The agent
-- now reports that true reason instead of claiming a user grant, and the API
-- must activate such a start only when the start it issued carried `proceed`.
-- Re-resolving the policy at answer time would let an edit between the offer
-- and the answer change the verdict, so the value is snapshotted next to
-- desktop_prompt_mode by the same start-intent commit.
--
-- NULL = the row predates this column or the start carried no prompt; the API
-- treats NULL as "not proceed" (fail closed). Schema-only: no row writes.

ALTER TABLE remote_sessions
  ADD COLUMN IF NOT EXISTS desktop_consent_unavailable_behavior text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'remote_sessions_desktop_consent_unavailable_behavior_check'
      AND conrelid = 'public.remote_sessions'::regclass
  ) THEN
    ALTER TABLE remote_sessions
      ADD CONSTRAINT remote_sessions_desktop_consent_unavailable_behavior_check
      CHECK (desktop_consent_unavailable_behavior IS NULL
             OR desktop_consent_unavailable_behavior IN ('proceed', 'block'));
  END IF;
END $$;
