-- #1374 (feature #4707, wave W02) — record the SIGNATURE ALGORITHM of a mobile
-- approver key.
--
-- Until now every mobile_hw_key was RSA-2048: react-native-biometrics is the
-- only thing that ever minted one, and services/mobileHwKey.ts hard-coded
-- 'RSA-SHA256'. W05/W06 replace that signer with a Secure Enclave / StrongBox
-- P-256 key, which can only sign ES256 — so the server has to know which
-- algorithm a given row's key uses.
--
-- The column is read SERVER-SIDE from this row on every verification. It is
-- deliberately NOT taken from the request body on the approval path: a
-- client-chosen algorithm is an algorithm-confusion vector (a caller could
-- present an EC key's bytes and ask for them to be read as RSA, or vice versa).
--
-- Tenancy: shape 6 (user-id scoped), unchanged. RLS is already ENABLE + FORCE
-- with policy authenticator_devices_user_scope
-- (2026-06-14-a-authenticator-foundation.sql) and the table is already in
-- USER_ID_SCOPED_TABLES. One column, no new policy, no new table. The table has
-- neither an `org_id` nor a `device_id` column, so it appears in none of
-- CORE_ORG_CASCADE_DELETE_ORDER / CORE_DEVICE_CASCADE_DELETE_TABLES /
-- CORE_DEVICE_ORG_DENORMALIZED_TABLES / CORE_TENANT_EXPORT_POLICY — and the
-- export policy classifies columns only for tables in the org-cascade list, so
-- this ADD COLUMN needs no export-policy entry either. (Verified by grep, not
-- assumed: zero matches for `authenticator_devices` in all three files.)

-- 1. Column -----------------------------------------------------------------
-- Every row that exists when this runs was minted by react-native-biometrics,
-- i.e. RSA-2048 — so the DEFAULT is already the correct classification for all
-- of them and there is no backfill UPDATE (hence no row-count RAISE).
ALTER TABLE authenticator_devices
  ADD COLUMN IF NOT EXISTS public_key_alg varchar(16) NOT NULL DEFAULT 'RS256';

-- 2. Domain constraint ------------------------------------------------------
-- varchar rather than a pg enum (adding an algorithm later must not need a
-- CREATE TYPE / ALTER TYPE dance on an auth table), but the domain is still
-- enforced in the DATABASE, not only in application code: an unrecognised label
-- is unverifiable, and services/mobileHwKey.ts#toMobileKeyAlg fails closed on
-- one. A row that could never be verified should not be storable in the first
-- place.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'authenticator_devices_public_key_alg_chk'
  ) THEN
    ALTER TABLE authenticator_devices
      ADD CONSTRAINT authenticator_devices_public_key_alg_chk
        CHECK (public_key_alg IN ('RS256', 'ES256'));
  END IF;
END $$;
