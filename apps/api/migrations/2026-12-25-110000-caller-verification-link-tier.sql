-- Caller verification W03 (#6354 / #6357): link-tier delivery material.
--
-- Two columns on the existing W01 table (RLS stays enabled + forced; no new
-- table, no cascade/merge change). Both are classified excludedSensitive in
-- CORE_TENANT_EXPORT_POLICY.
--   sealed_link_token  encrypted, row-bound copy of the SMS/email link token so
--                      the post-commit publisher can (re)deliver it; the clear
--                      token is never stored (challenge_token_hash is its digest).
--   challenge_choices  the three candidate numbers in their fixed on-screen
--                      order, written once at preparation; the public card
--                      returns it verbatim.
--
-- DDL only (no row writes), idempotent, no inner transaction control.

ALTER TABLE caller_verifications ADD COLUMN IF NOT EXISTS sealed_link_token text;
ALTER TABLE caller_verifications ADD COLUMN IF NOT EXISTS challenge_choices char(2)[];

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cv_link_choices_chk' AND conrelid = 'public.caller_verifications'::regclass
  ) THEN
    ALTER TABLE caller_verifications ADD CONSTRAINT cv_link_choices_chk CHECK (
      challenge_choices IS NULL OR (
        cardinality(challenge_choices) = 3
        AND array_position(challenge_choices, NULL) IS NULL
        AND challenge_choices[1] <> challenge_choices[2]
        AND challenge_choices[1] <> challenge_choices[3]
        AND challenge_choices[2] <> challenge_choices[3]
        AND challenge_choices @> ARRAY[match_value]
        AND challenge_choices @> decoy_values
      )
    );
  END IF;
END $$;
