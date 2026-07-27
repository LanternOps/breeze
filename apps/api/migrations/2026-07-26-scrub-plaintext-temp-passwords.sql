-- Redact historical plaintext temporary passwords.
--
-- Redact, do not re-seal: these credentials are weeks old, all carried
-- forceChangePasswordNextSignIn, and preserving a secret nobody asked to keep
-- is the opposite of the goal. Operators whose credential is burned here must
-- reset the password again.
--
-- SEQUENCING: internal/security/temp-password-exposure-survey.sql is a
-- manual, operator-run survey (gitignored, not part of this deploy). THIS
-- migration auto-applies on the next deploy via autoMigrate — it does not
-- wait for anyone to run the survey first. If an operator wants to inspect
-- the affected rows before they are redacted, the survey must be run BEFORE
-- this migration ships, not after.
--
-- Row counts are logged UNCONDITIONALLY, including zero. This deliberately
-- deviates from the CLAUDE.md `IF n > 0 THEN RAISE WARNING` convention for
-- cleanup statements: a zero count is itself the evidence that no exposure
-- occurred, and this migration may be cited as a forensic record of that
-- fact. Do not "fix" this back to a conditional guard. Never log values, row
-- ids, or org ids here — counts and static table labels only.
--
-- Re-running is a no-op: every predicate excludes already-redacted rows.
--
-- POST-CONDITION on ALL THREE tables, not just action_intents: GET
-- DIAGNOSTICS ROW_COUNT counts WHERE-matched rows, not rows whose text
-- actually changed. If a historical row's wording doesn't exactly match the
-- anchored suffix (different punctuation, a truncated row, a wording variant
-- predating the current template), regexp_replace silently no-ops on the
-- text while the UPDATE still reports a nonzero "redacted" count — the
-- exact "marked clean while still exposed" failure this migration exists to
-- prevent. Each table therefore gets its own fail-loud residual check below;
-- do not remove any of them or assume action_intents' check is sufficient
-- coverage for ai_messages / ai_tool_executions.

DO $$
DECLARE n bigint;
BEGIN
  UPDATE action_intents
  SET result = (result - 'temporaryPassword')
               || jsonb_build_object('temporaryPasswordExpired', true)
  WHERE action_name IN ('m365_reset_password', 'google_reset_password')
    AND result ? 'temporaryPassword';
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'scrub: action_intents legacy-key rows redacted: %', n;
END $$;

DO $$
DECLARE n bigint;
BEGIN
  UPDATE action_intents
  SET result = jsonb_set(
        result,
        '{raw}',
        to_jsonb(
          regexp_replace(
            result->>'raw',
            '(Temporary password: ).*?( \(the user must change it at next sign-in\)\.)',
            '\1[redacted]\2',
            'g'
          )
        )
      ) || jsonb_build_object('temporaryPasswordExpired', true)
  WHERE action_name IN ('m365_reset_password', 'google_reset_password')
    AND result->>'raw' LIKE '%Temporary password:%'
    AND result->>'raw' NOT LIKE '%[redacted]%'
    AND result->>'raw' NOT LIKE '%[REDACTED]%';
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'scrub: action_intents prose rows redacted: %', n;
END $$;

DO $$
DECLARE n bigint;
BEGIN
  UPDATE ai_messages
  SET tool_output = jsonb_set(
        tool_output,
        '{raw}',
        to_jsonb(
          regexp_replace(
            tool_output->>'raw',
            '(Temporary password: ).*?( \(the user must change it at next sign-in\)\.)',
            '\1[redacted]\2',
            'g'
          )
        )
      )
  WHERE tool_name IN ('m365_reset_password', 'google_reset_password')
    AND tool_output->>'raw' LIKE '%Temporary password:%'
    AND tool_output->>'raw' NOT LIKE '%[redacted]%'
    AND tool_output->>'raw' NOT LIKE '%[REDACTED]%';
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'scrub: ai_messages rows redacted: %', n;
END $$;

DO $$
DECLARE n bigint;
BEGIN
  UPDATE ai_tool_executions
  SET tool_output = jsonb_set(
        tool_output,
        '{raw}',
        to_jsonb(
          regexp_replace(
            tool_output->>'raw',
            '(Temporary password: ).*?( \(the user must change it at next sign-in\)\.)',
            '\1[redacted]\2',
            'g'
          )
        )
      )
  WHERE tool_name IN ('m365_reset_password', 'google_reset_password')
    AND tool_output->>'raw' LIKE '%Temporary password:%'
    AND tool_output->>'raw' NOT LIKE '%[redacted]%'
    AND tool_output->>'raw' NOT LIKE '%[REDACTED]%';
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'scrub: ai_tool_executions rows redacted: %', n;
END $$;

-- Post-condition: no suspected plaintext may remain, in ANY of the three
-- tables. GET DIAGNOSTICS above only proves the UPDATE matched rows, not
-- that regexp_replace changed their text — these three checks are what
-- actually prove the redaction worked (or fail loudly if it didn't).
DO $$
DECLARE remaining bigint;
BEGIN
  SELECT count(*) INTO remaining
  FROM action_intents
  WHERE action_name IN ('m365_reset_password', 'google_reset_password')
    AND ((result ? 'temporaryPassword')
      OR (result->>'raw' LIKE '%Temporary password:%'
          AND result->>'raw' NOT LIKE '%[redacted]%'
          AND result->>'raw' NOT LIKE '%[REDACTED]%'));
  IF remaining > 0 THEN
    RAISE EXCEPTION 'scrub incomplete: % action_intents rows still hold suspected plaintext', remaining;
  END IF;
  RAISE WARNING 'scrub: post-condition clean, 0 residual plaintext rows (action_intents)';
END $$;

DO $$
DECLARE remaining bigint;
BEGIN
  SELECT count(*) INTO remaining
  FROM ai_messages
  WHERE tool_name IN ('m365_reset_password', 'google_reset_password')
    AND tool_output->>'raw' LIKE '%Temporary password:%'
    AND tool_output->>'raw' NOT LIKE '%[redacted]%'
    AND tool_output->>'raw' NOT LIKE '%[REDACTED]%';
  IF remaining > 0 THEN
    RAISE EXCEPTION 'scrub incomplete: % ai_messages rows still hold suspected plaintext', remaining;
  END IF;
  RAISE WARNING 'scrub: post-condition clean, 0 residual plaintext rows (ai_messages)';
END $$;

DO $$
DECLARE remaining bigint;
BEGIN
  SELECT count(*) INTO remaining
  FROM ai_tool_executions
  WHERE tool_name IN ('m365_reset_password', 'google_reset_password')
    AND tool_output->>'raw' LIKE '%Temporary password:%'
    AND tool_output->>'raw' NOT LIKE '%[redacted]%'
    AND tool_output->>'raw' NOT LIKE '%[REDACTED]%';
  IF remaining > 0 THEN
    RAISE EXCEPTION 'scrub incomplete: % ai_tool_executions rows still hold suspected plaintext', remaining;
  END IF;
  RAISE WARNING 'scrub: post-condition clean, 0 residual plaintext rows (ai_tool_executions)';
END $$;
