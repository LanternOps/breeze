-- Widen m365_consent_sessions.profile to admit the customer-graph-actions profile.
-- The read-consent migration pinned this to a single value; onboarding a second
-- profile reuses the same table.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'm365_consent_sessions_profile_check'
      AND conrelid = 'm365_consent_sessions'::regclass
  ) THEN
    ALTER TABLE m365_consent_sessions DROP CONSTRAINT m365_consent_sessions_profile_check;
  END IF;
END $$;

ALTER TABLE m365_consent_sessions
  ADD CONSTRAINT m365_consent_sessions_profile_check
  CHECK (profile IN ('customer-graph-read', 'customer-graph-actions'));
