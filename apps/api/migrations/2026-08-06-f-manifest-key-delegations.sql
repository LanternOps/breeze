-- Signed, monotonic, time-bounded manifest signing key delegation
-- (security remediation Wave 6, Task 7).
--
-- WHY THIS TABLE EXISTS
-- Wave 6 Task 6 froze trust-on-first-use in the agent: once an agent has
-- pinned its one deployment manifest signing key, ANY previously unseen key
-- delivered over enrollment/heartbeat is rejected outright
-- (ErrManifestTrustExpansionRejected). That deliberately removed the ability
-- of a control plane with API/database write access — but WITHOUT the signing
-- private key — to quietly introduce a key of its own and sign updates with
-- it. Agent updates run as SYSTEM/root, so that was a full remote-code
-- execution path.
--
-- A row in this table is the ONLY way that freeze is ever lifted. Each row
-- carries an Ed25519 signature, produced by the key that is ALREADY trusted,
-- over a canonical byte string binding: the old key ID, the new key ID, the
-- new public key, a monotonic epoch, and a validity window. Database write
-- access alone cannot forge one, because the attacker cannot produce that
-- signature. See services/manifestSigning.ts (manifestDelegationCanonicalBytes)
-- and agent/internal/config/manifestdelegation.go (ManifestDelegationCanonicalBytes)
-- for the byte-exact layout, which both sides define independently and pin
-- with the same golden digest in their tests.
--
-- TENANCY
-- System-scoped, exactly like `manifest_signing_keys` (2026-05-09): this is
-- per-deployment agent-update infrastructure with NO tenant axis at all. It
-- gets ENABLE + FORCE ROW LEVEL SECURITY plus ONE system-only policy whose
-- USING *and* WITH CHECK both require breeze.scope = 'system'. Registered in
-- INTENTIONAL_UNSCOPED in rls-coverage.integration.test.ts. Because it has no
-- `org_id` and no `device_id` column, it needs NO cascade-list registration
-- (CORE_ORG_CASCADE_DELETE_ORDER / CORE_DEVICE_CASCADE_DELETE_TABLES /
-- CORE_DEVICE_ORG_DENORMALIZED_TABLES all key off those columns).
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, DO $$ guards, pg_policies existence
-- check. No inner transaction directives — autoMigrate already wraps each file
-- in client.begin(...), so opening another one here would only emit
-- "there is already a transaction in progress".

CREATE TABLE IF NOT EXISTS manifest_signing_key_delegations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Monotonic replay counter. UNIQUE enforces "no epoch reuse" at the storage
  -- layer rather than only in the rotation CLI's pre-checks: even a racing or
  -- buggy second `prepare` cannot mint a duplicate. The agent independently
  -- requires epoch > its own persisted epoch, so an already-adopted epoch can
  -- never be replayed back at it.
  epoch               bigint NOT NULL UNIQUE,
  old_key_id          text NOT NULL,
  new_key_id          text NOT NULL,
  new_public_key_b64  text NOT NULL,
  not_before          timestamptz NOT NULL,
  not_after           timestamptz NOT NULL,
  -- Ed25519 signature (base64) over the canonical delegation bytes, made with
  -- old_key_id's private key. Never logged.
  signature_b64       text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- NULL means "prepared but not activated". `prepare` never sets it;
  -- `activate` sets it in the same transaction that retires the old signing
  -- key and activates the new one.
  activated_at        timestamptz
);

-- A zero-length or inverted window would be un-adoptable by every agent while
-- still consuming an epoch. Reject it at write time.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'manifest_signing_key_delegations_window_chk'
      AND conrelid = 'manifest_signing_key_delegations'::regclass
  ) THEN
    ALTER TABLE manifest_signing_key_delegations
      ADD CONSTRAINT manifest_signing_key_delegations_window_chk
      CHECK (not_after > not_before);
  END IF;
END$$;

-- Enrollment and heartbeat select the currently-in-window records on every
-- agent check-in; this is the supporting index for that predicate.
CREATE INDEX IF NOT EXISTS idx_manifest_signing_key_delegations_window
  ON manifest_signing_key_delegations(not_before, not_after);

-- System-scoped: agent-update infrastructure. Forced RLS gates access so the
-- breeze_app role can read/write only when running under the system DB context
-- (set by withSystemDbAccessContext). Policy shape copied verbatim from
-- manifest_signing_keys — USING *and* WITH CHECK. A USING-only policy would
-- let a tenant-scoped context INSERT rows it cannot read, which for this table
-- means forging a delegation.
ALTER TABLE manifest_signing_key_delegations ENABLE ROW LEVEL SECURITY;
ALTER TABLE manifest_signing_key_delegations FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'manifest_signing_key_delegations'
      AND policyname = 'manifest_signing_key_delegations_system_only'
  ) THEN
    EXECUTE $POLICY$
      CREATE POLICY manifest_signing_key_delegations_system_only
        ON manifest_signing_key_delegations
        USING (current_setting('breeze.scope', true) = 'system')
        WITH CHECK (current_setting('breeze.scope', true) = 'system')
    $POLICY$;
  END IF;
END$$;

-- Only what the system-context service role actually requires: SELECT (agent
-- delivery), INSERT (`prepare`), UPDATE (`activate` stamps activated_at).
-- DELETE is deliberately NOT granted — nothing in the delegation lifecycle
-- removes a record, and the row history is the audit trail for a trust change.
--
-- Note this GRANT is belt-and-braces: db/ensureAppRole.ts runs a blanket
-- `GRANT ... ON ALL TABLES IN SCHEMA public TO breeze_app` plus ALTER DEFAULT
-- PRIVILEGES at every boot, so breeze_app will also pick up DELETE from there.
-- We do NOT attempt a REVOKE here, because that bootstrap would silently undo
-- it on the next restart and leave the migration lying about the end state.
-- RLS, not the grant, is the enforcement boundary for this table.
GRANT SELECT, INSERT, UPDATE ON manifest_signing_key_delegations TO breeze_app;
