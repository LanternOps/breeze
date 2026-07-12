-- Invalidate Wave 1 sessions exactly once: those tokens predate trustworthy AMR.
-- The runner records this filename in breeze_migrations in the same outer
-- transaction after this file succeeds. The ledger check also makes a manual
-- re-application a no-op for the epoch advance.
DO $$
DECLARE
  n integer := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM breeze_migrations
    WHERE filename = '2026-07-11-b-mfa-assurance.sql'
  ) THEN
    UPDATE users
    SET mfa_epoch = mfa_epoch + 1;
    GET DIAGNOSTICS n = ROW_COUNT;
  END IF;
  RAISE WARNING 'advanced mfa_epoch on % users row(s) for MFA assurance rollout', n;
END $$;

-- Copy the legacy partner key only when the canonical key is absent.
DO $$
DECLARE
  n integer;
BEGIN
  UPDATE partners
  SET settings = jsonb_set(
    settings,
    '{security}',
    (settings->'security') || jsonb_build_object(
      'allowedMethods',
      settings->'security'->'allowedMfaMethods'
    ),
    false
  )
  WHERE jsonb_typeof(settings) = 'object'
    AND jsonb_typeof(settings->'security') = 'object'
    AND settings->'security' ? 'allowedMfaMethods'
    AND NOT (settings->'security' ? 'allowedMethods');
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'copied legacy allowedMfaMethods for % partner row(s)', n;
END $$;

-- Retire the partner alias even when canonical data already existed.
DO $$
DECLARE
  n integer;
BEGIN
  UPDATE partners
  SET settings = jsonb_set(
    settings,
    '{security}',
    (settings->'security') - 'allowedMfaMethods',
    false
  )
  WHERE jsonb_typeof(settings) = 'object'
    AND jsonb_typeof(settings->'security') = 'object'
    AND settings->'security' ? 'allowedMfaMethods';
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'removed legacy allowedMfaMethods from % partner row(s)', n;
END $$;

-- Copy the legacy organization key only when the canonical key is absent.
DO $$
DECLARE
  n integer;
BEGIN
  UPDATE organizations
  SET settings = jsonb_set(
    settings,
    '{security}',
    (settings->'security') || jsonb_build_object(
      'allowedMethods',
      settings->'security'->'allowedMfaMethods'
    ),
    false
  )
  WHERE jsonb_typeof(settings) = 'object'
    AND jsonb_typeof(settings->'security') = 'object'
    AND settings->'security' ? 'allowedMfaMethods'
    AND NOT (settings->'security' ? 'allowedMethods');
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'copied legacy allowedMfaMethods for % organization row(s)', n;
END $$;

-- Retire the organization alias even when canonical data already existed.
DO $$
DECLARE
  n integer;
BEGIN
  UPDATE organizations
  SET settings = jsonb_set(
    settings,
    '{security}',
    (settings->'security') - 'allowedMfaMethods',
    false
  )
  WHERE jsonb_typeof(settings) = 'object'
    AND jsonb_typeof(settings->'security') = 'object'
    AND settings->'security' ? 'allowedMfaMethods';
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'removed legacy allowedMfaMethods from % organization row(s)', n;
END $$;
