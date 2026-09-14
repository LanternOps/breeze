-- M365 tenant sync foundation, spec §2.2 — distinguish a first-time consent
-- session from a manifest UPGRADE consent session.
--
-- Why a column and not an inference from connection status: an upgrade session
-- is minted against an ACTIVE connection and must never move it to
-- pending-consent, so the callback has to know which flow it is resuming
-- BEFORE it decides which connection statuses are legal. Inferring it from the
-- connection's current status would make the callback's behaviour depend on a
-- row that a concurrent re-consent can change underneath it.
--
-- DDL only: no DML, so no breeze.scope setting is required. Existing rows are
-- all first-time sessions, which is exactly the DEFAULT.

ALTER TABLE m365_consent_sessions
  ADD COLUMN IF NOT EXISTS purpose varchar(16) NOT NULL DEFAULT 'initial';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'm365_consent_sessions_purpose_check'
      AND conrelid = 'public.m365_consent_sessions'::regclass
  ) THEN
    ALTER TABLE m365_consent_sessions
      ADD CONSTRAINT m365_consent_sessions_purpose_check
      CHECK (purpose IN ('initial', 'upgrade'));
  END IF;
END $$;
