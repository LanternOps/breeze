-- 2026-06-17-authenticator-assurance-check-constraints.sql
-- Issue #1372 — deferred follow-up from the PR #1369 (Breeze Authenticator)
-- review. Storage-side mirror of assertDecisionConsistent()
-- (apps/api/src/services/authenticatorAssurance.ts).
--
-- The factor-recording columns on approval_requests + elevation_requests are a
-- forensic/audit record, but the fields are independent at the DB level, so the
-- store accepts self-contradictory tuples the application would never write
-- (e.g. decided_via='session_tap' with a device id, decided_assurance_level=7,
-- or an L2+ factor at level 1). The application guards this at write time, but
-- the storage boundary — the thing actually being protected — was the loosest
-- link. These CHECK constraints make the illegal states unrepresentable.
--
-- Invariants (match assertDecisionConsistent):
--   * decided_assurance_level, when set, is 1..4.
--   * session_tap  <=>  no authenticator device  (an L2+ factor records one).
--   * session_tap  <=>  level 1                   (a proof factor is never L1).
--   * pin_verified implies level >= 3             (legacy approver-PIN gate).
--
-- Every undecided / pending row (decided_via, decided_assurance_level,
-- authenticator_device_id all NULL) passes: each predicate short-circuits to
-- NULL — and a NULL CHECK result is treated as satisfied.
--
-- Idempotent: each ADD CONSTRAINT is pg_constraint-guarded. No inner
-- BEGIN/COMMIT (autoMigrate wraps each file in its own transaction). The tables
-- are effectively empty (feature ships dark at the L1 default), so validation
-- is cheap; if any pre-existing row violates a predicate the ADD will RAISE —
-- that is the intended loud signal that the write-time guard was bypassed, not
-- something to silence.

-- approval_requests --------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'approval_requests_decided_level_range_chk') THEN
    ALTER TABLE approval_requests ADD CONSTRAINT approval_requests_decided_level_range_chk
      CHECK (decided_assurance_level IS NULL OR decided_assurance_level BETWEEN 1 AND 4);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'approval_requests_factor_device_chk') THEN
    ALTER TABLE approval_requests ADD CONSTRAINT approval_requests_factor_device_chk
      CHECK ((decided_via = 'session_tap') = (authenticator_device_id IS NULL));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'approval_requests_factor_level_chk') THEN
    ALTER TABLE approval_requests ADD CONSTRAINT approval_requests_factor_level_chk
      CHECK ((decided_via = 'session_tap') = (decided_assurance_level = 1));
  END IF;
END $$;

-- elevation_requests -------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'elevation_requests_decided_level_range_chk') THEN
    ALTER TABLE elevation_requests ADD CONSTRAINT elevation_requests_decided_level_range_chk
      CHECK (decided_assurance_level IS NULL OR decided_assurance_level BETWEEN 1 AND 4);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'elevation_requests_factor_device_chk') THEN
    ALTER TABLE elevation_requests ADD CONSTRAINT elevation_requests_factor_device_chk
      CHECK ((decided_via = 'session_tap') = (authenticator_device_id IS NULL));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'elevation_requests_factor_level_chk') THEN
    ALTER TABLE elevation_requests ADD CONSTRAINT elevation_requests_factor_level_chk
      CHECK ((decided_via = 'session_tap') = (decided_assurance_level = 1));
  END IF;
END $$;

-- pin_verified gate --------------------------------------------------------
-- The approver PIN is being removed in favour of an L4 account re-auth
-- (PR #1433 drops these columns). This constraint is therefore applied only
-- while the column still exists; once the column is dropped Postgres removes
-- the dependent CHECK automatically, and this guarded block becomes a no-op.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'approval_requests' AND column_name = 'pin_verified'
  ) AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'approval_requests_pin_level_chk') THEN
    ALTER TABLE approval_requests ADD CONSTRAINT approval_requests_pin_level_chk
      CHECK (NOT pin_verified OR decided_assurance_level >= 3);
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'elevation_requests' AND column_name = 'pin_verified'
  ) AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'elevation_requests_pin_level_chk') THEN
    ALTER TABLE elevation_requests ADD CONSTRAINT elevation_requests_pin_level_chk
      CHECK (NOT pin_verified OR decided_assurance_level >= 3);
  END IF;
END $$;
