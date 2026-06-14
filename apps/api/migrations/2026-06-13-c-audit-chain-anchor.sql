-- Issue #916: external anchor for the audit tamper-evidence chain (phase 1).
--
-- BACKGROUND
-- ----------
-- The audit hash-chain lives entirely in Postgres: the in-row checksum on
-- audit_logs (PR #900) and, since #1002, the append-only audit_log_chain side
-- table (migrations 2026-06-11-g / -h). audit_log_verify_chain() walks that
-- side table and catches per-row tampering. PR #1240 schedules that verifier
-- daily and pages on any break.
--
-- THE GAP THIS MIGRATION CLOSES
-- -----------------------------
-- Both audit_logs and audit_log_chain are reachable from the same database the
-- application role writes to. A privileged DB compromise (Postgres takeover,
-- doadmin, a forced bypass of the append-only triggers, or a full
-- `session_replication_role=replica` DELETE of *both* tables) can wipe the
-- chain and re-seal a fresh, internally-consistent forgery. verify_chain would
-- then return clean: there is no record OUTSIDE the chain of what the head used
-- to be. A shrunk row count after a DELETE is, by itself, invisible.
--
-- An *anchor* breaks that: periodically we snapshot the current chain head
-- (org_id, head chain_seq, head chain_checksum, entry count) into a SECOND
-- append-only table that breeze_app may INSERT but NEVER UPDATE/DELETE, and
-- (in the app layer) sign + ship off-box for true external retention. The
-- live chain is then checked against the latest anchor: if the head moved
-- BACKWARDS (fewer entries / lower seq) or the checksum at the anchored seq no
-- longer matches, the chain was rewritten — flag it even though the rewritten
-- chain is internally self-consistent.
--
-- PHASE 1 SCOPE: in-DB append-only anchor + signing seam + anchor-divergence
-- verification. The remaining step — shipping each signed anchor to immutable
-- off-box storage (S3 Object Lock / write-only host / SIEM) — is wired through
-- the app layer (jobs/auditChainAnchor.ts emits a signed, structured log line
-- for log-forwarder pickup) but the durable external sink itself is deferred
-- pending the infra decision tracked on #916.
--
-- ANCHOR vs CHAIN: distinct trust domains on purpose. audit_log_chain is
-- written on the hot path by breeze_app at every audit insert. The anchor is
-- written on a slow cadence by a background job and is the thing we later push
-- off-box. Keeping them separate means a forger has to defeat BOTH the
-- in-tx append-only trigger AND the externally-retained anchor.

-- ---------------------------------------------------------------------------
-- (1) audit_chain_anchors — append-only anchor snapshots.
-- ---------------------------------------------------------------------------
-- One row per (org, snapshot). anchor_seq is the global monotonic order;
-- per-org history is walked by (org_id, anchor_seq). head_chain_seq /
-- head_chain_checksum capture the audit_log_chain head at snapshot time;
-- entry_count is the number of chain entries for that org at snapshot time
-- (the value a DELETE-then-reseal would shrink). signature/signing_key_id are
-- the app-layer Ed25519 seam (NULL when signing is not configured).
CREATE TABLE IF NOT EXISTS audit_chain_anchors (
  anchor_seq bigserial PRIMARY KEY,
  org_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  -- ON DELETE CASCADE mirrors audit_log_chain: an anchor is org metadata and
  -- must not block a total org erasure. The off-box copy (phase-2) is the
  -- durable record across an org delete.
  head_chain_seq bigint NOT NULL,
  head_chain_checksum varchar(128),
  -- NULL head_chain_checksum + head_chain_seq=0 encodes "empty chain at
  -- snapshot time" (org with zero audit rows). A later non-empty head is a
  -- normal forward move, not a divergence.
  entry_count bigint NOT NULL,
  signature text,
  signing_key_id varchar(128),
  anchored_at timestamptz NOT NULL DEFAULT now()
);

-- Per-org head lookup: latest anchor = WHERE org_id = $1 (or IS NULL)
-- ORDER BY anchor_seq DESC LIMIT 1.
CREATE INDEX IF NOT EXISTS audit_chain_anchors_org_seq_idx
  ON audit_chain_anchors (org_id, anchor_seq DESC);

-- RLS: tenancy shape 1 (direct org_id) — the standard four policies that
-- rls-coverage.integration.test.ts auto-discovery expects. NULL-org rows
-- (the system chain anchor) are reachable only by system scope, exactly like
-- audit_log_chain.
ALTER TABLE audit_chain_anchors ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_chain_anchors FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                 AND tablename = 'audit_chain_anchors' AND policyname = 'breeze_org_isolation_select') THEN
    CREATE POLICY breeze_org_isolation_select ON public.audit_chain_anchors
      FOR SELECT USING (public.breeze_has_org_access(org_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                 AND tablename = 'audit_chain_anchors' AND policyname = 'breeze_org_isolation_insert') THEN
    CREATE POLICY breeze_org_isolation_insert ON public.audit_chain_anchors
      FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                 AND tablename = 'audit_chain_anchors' AND policyname = 'breeze_org_isolation_update') THEN
    CREATE POLICY breeze_org_isolation_update ON public.audit_chain_anchors
      FOR UPDATE USING (public.breeze_has_org_access(org_id))
      WITH CHECK (public.breeze_has_org_access(org_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                 AND tablename = 'audit_chain_anchors' AND policyname = 'breeze_org_isolation_delete') THEN
    CREATE POLICY breeze_org_isolation_delete ON public.audit_chain_anchors
      FOR DELETE USING (public.breeze_has_org_access(org_id));
  END IF;
END $$;

-- Privileges: breeze_app may read and APPEND only — never mutate. This is the
-- core of the anchor's trust value: the same app credential that writes audit
-- rows cannot rewrite (or remove) a prior anchor to cover a chain forgery.
-- A full SQLi/RCE inside the API process is INSERT-only here AT THE breeze_app
-- LAYER. Note the broader "even full SQLi/RCE is INSERT-only" claim only holds
-- once the manual #915 hardening step — `REVOKE breeze_audit_admin FROM
-- breeze_app` — has been applied: by default breeze_app is a no-op member of
-- breeze_audit_admin and the #915 migration only emits a NOTICE, so an attacker
-- who can `SET ROLE breeze_audit_admin` could still DELETE under the retention
-- GUC until that REVOKE is run. The append-only TRIGGER below is the layer that
-- holds regardless. Retention pruning of very old anchors (if ever needed) goes
-- through breeze_audit_admin plus the retention GUC, matching audit_log_chain.
GRANT SELECT, INSERT ON TABLE audit_chain_anchors TO breeze_app;
REVOKE UPDATE, DELETE ON TABLE audit_chain_anchors FROM breeze_app;
GRANT USAGE ON SEQUENCE audit_chain_anchors_anchor_seq_seq TO breeze_app;
-- USAGE (nextval via the bigserial INSERT DEFAULT) is sufficient for appending
-- anchors; UPDATE (setval) would let breeze_app rewind/jump anchor_seq and break
-- the monotonic ordering the off-box verifier relies on. Revoke it explicitly so
-- the restriction is recorded in the migration as well as re-applied on every
-- boot by ensureAppRole step 5 (the blanket GRANT ON ALL SEQUENCES there runs
-- AFTER migrations and would otherwise silently re-permit setval — same
-- DoS-grade gap closed for audit_log_chain_chain_seq_seq).
REVOKE UPDATE ON SEQUENCE audit_chain_anchors_anchor_seq_seq FROM breeze_app;
GRANT SELECT, DELETE ON TABLE audit_chain_anchors TO breeze_audit_admin;
REVOKE UPDATE ON TABLE audit_chain_anchors FROM breeze_audit_admin;

-- Append-only enforcement, mirroring audit_log_chain_immutable: UPDATE is
-- NEVER permitted (an anchor is a point-in-time fact and is never rewritten);
-- DELETE only under the retention GUC or via an FK cascade (org erasure).
CREATE OR REPLACE FUNCTION audit_chain_anchor_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  allow_retention text := current_setting('breeze.allow_audit_retention', true);
BEGIN
  IF TG_OP = 'DELETE' AND (allow_retention = '1' OR pg_trigger_depth() > 1) THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = 'P0001',
    MESSAGE = 'audit chain anchors are append-only',
    HINT = 'audit_chain_anchors rows cannot be modified or deleted. This is the external-anchor guarantee for issue #916: the head snapshot used to detect a forged-chain-after-DELETE must outlive any app-role rewrite. Retention/erasure uses breeze_audit_admin plus the breeze.allow_audit_retention GUC (DELETE only).';
END;
$$;

DROP TRIGGER IF EXISTS audit_chain_anchor_block_update ON audit_chain_anchors;
CREATE TRIGGER audit_chain_anchor_block_update BEFORE UPDATE ON audit_chain_anchors
  FOR EACH ROW EXECUTE FUNCTION audit_chain_anchor_immutable();

DROP TRIGGER IF EXISTS audit_chain_anchor_block_delete ON audit_chain_anchors;
CREATE TRIGGER audit_chain_anchor_block_delete BEFORE DELETE ON audit_chain_anchors
  FOR EACH ROW EXECUTE FUNCTION audit_chain_anchor_immutable();

-- ---------------------------------------------------------------------------
-- (1b) audit_chain_read_head(org_id) — read-only head snapshot (no write).
-- ---------------------------------------------------------------------------
-- The app reads the head with this, signs the canonical payload off-DB, then
-- calls audit_chain_anchor_head with that signature. Empty chain → seq 0 /
-- NULL checksum / count 0.
CREATE OR REPLACE FUNCTION audit_chain_read_head(p_org_id uuid)
RETURNS TABLE (
  head_chain_seq bigint,
  head_chain_checksum varchar,
  entry_count bigint
)
LANGUAGE plpgsql AS $$
DECLARE
  v_head_seq bigint;
  v_head_checksum varchar(128);
  v_count bigint;
BEGIN
  IF p_org_id IS NULL THEN
    SELECT ch.chain_seq, ch.chain_checksum INTO v_head_seq, v_head_checksum
    FROM audit_log_chain ch WHERE ch.org_id IS NULL
    ORDER BY ch.chain_seq DESC LIMIT 1;
    SELECT count(*) INTO v_count FROM audit_log_chain ch WHERE ch.org_id IS NULL;
  ELSE
    SELECT ch.chain_seq, ch.chain_checksum INTO v_head_seq, v_head_checksum
    FROM audit_log_chain ch WHERE ch.org_id = p_org_id
    ORDER BY ch.chain_seq DESC LIMIT 1;
    SELECT count(*) INTO v_count FROM audit_log_chain ch WHERE ch.org_id = p_org_id;
  END IF;
  head_chain_seq := COALESCE(v_head_seq, 0);
  head_chain_checksum := v_head_checksum;
  entry_count := v_count;
  RETURN NEXT;
END;
$$;

-- ---------------------------------------------------------------------------
-- (2) audit_chain_anchor_head(org_id, signature, signing_key_id) — snapshot the
--     current chain head into a new anchor row and return it.
-- ---------------------------------------------------------------------------
-- SECURITY INVOKER: runs under the caller's RLS context. The background job
-- calls it from system context (covers the NULL-org system chain and every
-- org uniformly). Reads the audit_log_chain head, counts that org's entries,
-- and INSERTs an anchor. The returned columns let the app layer ship the
-- snapshot off-box.
--
-- Signing happens in the APP layer (services/auditAnchorSigning.ts): the seed
-- never enters Postgres, so a DB-only compromise cannot forge a signature.
-- The caller signs the canonical payload it intends to anchor and passes the
-- base64 signature + key id straight into the INSERT. Both default NULL so the
-- function is callable unsigned (signing disabled, and the integration tests
-- that don't exercise signing). Because the anchor table is UPDATE-blocked,
-- the signature MUST be supplied at insert time — there is deliberately no
-- after-the-fact "attach signature" path.
--
-- TOCTOU note: the app reads the head (a prior call), signs it, then calls
-- this. Between the two the live head may have ADVANCED. That is safe: the
-- function re-reads and anchors whatever the head is NOW, and only stamps the
-- supplied signature when the re-read head still matches what was signed
-- (p_expected_head_seq). On mismatch it anchors UNSIGNED rather than attach a
-- signature over a stale payload — the next cycle re-signs the advanced head.
-- Anchors only ever move forward, so a transiently-unsigned anchor is benign.
--
-- Empty chain (org has never written audit rows): head_chain_seq=0,
-- head_chain_checksum=NULL, entry_count=0. Anchoring an empty chain is
-- harmless and gives a baseline the first real entry must build forward from.
CREATE OR REPLACE FUNCTION audit_chain_anchor_head(
  p_org_id uuid,
  p_signature text DEFAULT NULL,
  p_signing_key_id varchar DEFAULT NULL,
  p_expected_head_seq bigint DEFAULT NULL,
  p_expected_entry_count bigint DEFAULT NULL,
  p_anchored_at timestamptz DEFAULT NULL
)
RETURNS TABLE (
  anchor_seq bigint,
  head_chain_seq bigint,
  head_chain_checksum varchar,
  entry_count bigint,
  anchored_at timestamptz,
  signed boolean
)
LANGUAGE plpgsql AS $$
DECLARE
  v_head_seq bigint;
  v_head_checksum varchar(128);
  v_count bigint;
  v_anchor_seq bigint;
  v_anchored_at timestamptz := COALESCE(p_anchored_at, now());
  v_sig text;
  v_key_id varchar(128);
BEGIN
  -- Head + count in one branch-on-NULL pass (audit_log_chain_org_seq_idx
  -- supports both the ORDER BY ... DESC head read and the count).
  IF p_org_id IS NULL THEN
    SELECT ch.chain_seq, ch.chain_checksum INTO v_head_seq, v_head_checksum
    FROM audit_log_chain ch WHERE ch.org_id IS NULL
    ORDER BY ch.chain_seq DESC LIMIT 1;
    SELECT count(*) INTO v_count FROM audit_log_chain ch WHERE ch.org_id IS NULL;
  ELSE
    SELECT ch.chain_seq, ch.chain_checksum INTO v_head_seq, v_head_checksum
    FROM audit_log_chain ch WHERE ch.org_id = p_org_id
    ORDER BY ch.chain_seq DESC LIMIT 1;
    SELECT count(*) INTO v_count FROM audit_log_chain ch WHERE ch.org_id = p_org_id;
  END IF;

  -- Empty chain → seq 0 / NULL checksum baseline.
  v_head_seq := COALESCE(v_head_seq, 0);

  -- Only stamp the supplied signature if the snapshot we are about to anchor is
  -- EXACTLY the one the caller signed: same head seq AND same entry count (the
  -- two facts the signature also covers besides the app-supplied timestamp).
  -- If the head advanced between the caller's sign-time read and this insert,
  -- we anchor UNSIGNED rather than attach a signature over a stale payload; the
  -- next cycle re-signs the advanced head. p_expected_head_seq NULL ⇒ caller is
  -- intentionally anchoring unsigned and skips the check.
  IF p_signature IS NOT NULL
     AND p_expected_head_seq IS NOT NULL
     AND p_expected_head_seq = v_head_seq
     AND (p_expected_entry_count IS NULL OR p_expected_entry_count = v_count) THEN
    v_sig := p_signature;
    v_key_id := p_signing_key_id;
  ELSE
    v_sig := NULL;
    v_key_id := NULL;
  END IF;

  INSERT INTO audit_chain_anchors (org_id, head_chain_seq, head_chain_checksum, entry_count, signature, signing_key_id, anchored_at)
  VALUES (p_org_id, v_head_seq, v_head_checksum, v_count, v_sig, v_key_id, v_anchored_at)
  RETURNING audit_chain_anchors.anchor_seq INTO v_anchor_seq;

  anchor_seq := v_anchor_seq;
  head_chain_seq := v_head_seq;
  head_chain_checksum := v_head_checksum;
  entry_count := v_count;
  anchored_at := v_anchored_at;
  signed := (v_sig IS NOT NULL);
  RETURN NEXT;
END;
$$;

-- ---------------------------------------------------------------------------
-- (3) audit_chain_verify_anchor(org_id) — compare the live chain head against
--     the most recent anchor and flag divergence.
-- ---------------------------------------------------------------------------
-- Returns ZERO rows when the chain is consistent with its latest anchor, and a
-- single explanatory row otherwise. This catches exactly the attack
-- audit_log_verify_chain cannot: a DELETE-then-reseal that produces an
-- internally valid but SHORTER (or differently-headed) chain.
--
-- reason values:
--   'no_anchor'       no anchor exists yet for this org (informational; not a
--                     tamper signal on its own — the first anchor establishes
--                     the baseline. The job treats this as "needs first
--                     anchor", not an incident.)
--   'count_shrank'    live entry_count < anchored entry_count (with the anchored
--                     head intact), OR the live chain is now FULLY EMPTY
--                     (live_head_seq=0 AND live_entry_count=0) while the anchor
--                     recorded a non-empty head → rows were pruned from
--                     audit_log_chain since the anchor. Benign-retention class:
--                     the empty-live case is what a full prune of a now-inactive
--                     org looks like and must NOT be mistaken for seq_regressed
--                     tamper (an empty chain has no forged head to detect).
--   'seq_regressed'   live head chain_seq < anchored head chain_seq → the head
--                     moved backwards (truncation/rewrite). bigserial only
--                     ever advances, so this can only happen via deletion.
--   'checksum_diverged' the audit_log_chain entry at the anchored head seq
--                     still exists but its chain_checksum no longer matches the
--                     anchored value → that historical entry was rewritten.
--   'anchored_head_missing' the chain entry at the anchored head seq is gone
--                     entirely (and the head didn't simply advance past it via
--                     legitimate retention — see note) → truncation.
--
-- Retention note: legitimate retention pruning normally deletes the OLDEST
-- chain entries, leaving the head in place, so count_shrank fires after a large
-- prune; the job distinguishes this by checking whether the anchored head seq
-- still exists with a matching checksum (chain intact, just a shorter prefix =
-- benign) vs. the head itself regressed/changed (tamper). The ONE exception is
-- a fully-inactive org whose retention window passes its newest row: the prune
-- then deletes THROUGH the anchored head and empties the chain. That collapses
-- live_head_seq/live_entry_count to 0, which would otherwise look like
-- seq_regressed — so branch (a0) special-cases an empty live chain against a
-- non-empty anchor as benign count_shrank, not tamper. We expose all signals
-- and let the job apply policy, keeping this function a pure observation.
CREATE OR REPLACE FUNCTION audit_chain_verify_anchor(p_org_id uuid)
RETURNS TABLE (
  reason text,
  anchor_seq bigint,
  anchored_head_seq bigint,
  anchored_entry_count bigint,
  live_head_seq bigint,
  live_entry_count bigint,
  anchored_head_checksum varchar,
  live_head_checksum varchar
)
LANGUAGE plpgsql AS $$
DECLARE
  a record;
  v_live_head_seq bigint;
  v_live_head_checksum varchar(128);
  v_live_count bigint;
  v_seq_checksum varchar(128);
  v_seq_exists boolean;
BEGIN
  -- Latest anchor for this org (NULL org = system chain).
  IF p_org_id IS NULL THEN
    SELECT * INTO a FROM audit_chain_anchors WHERE org_id IS NULL
    ORDER BY audit_chain_anchors.anchor_seq DESC LIMIT 1;
  ELSE
    SELECT * INTO a FROM audit_chain_anchors WHERE org_id = p_org_id
    ORDER BY audit_chain_anchors.anchor_seq DESC LIMIT 1;
  END IF;

  IF NOT FOUND THEN
    reason := 'no_anchor';
    anchor_seq := NULL; anchored_head_seq := NULL; anchored_entry_count := NULL;
    live_head_seq := NULL; live_entry_count := NULL;
    anchored_head_checksum := NULL; live_head_checksum := NULL;
    RETURN NEXT;
    RETURN;
  END IF;

  -- Live head + count.
  IF p_org_id IS NULL THEN
    SELECT ch.chain_seq, ch.chain_checksum INTO v_live_head_seq, v_live_head_checksum
    FROM audit_log_chain ch WHERE ch.org_id IS NULL
    ORDER BY ch.chain_seq DESC LIMIT 1;
    SELECT count(*) INTO v_live_count FROM audit_log_chain ch WHERE ch.org_id IS NULL;
  ELSE
    SELECT ch.chain_seq, ch.chain_checksum INTO v_live_head_seq, v_live_head_checksum
    FROM audit_log_chain ch WHERE ch.org_id = p_org_id
    ORDER BY ch.chain_seq DESC LIMIT 1;
    SELECT count(*) INTO v_live_count FROM audit_log_chain ch WHERE ch.org_id = p_org_id;
  END IF;
  v_live_head_seq := COALESCE(v_live_head_seq, 0);

  -- Does the anchored head seq still exist, and with the same checksum?
  SELECT ch.chain_checksum INTO v_seq_checksum
  FROM audit_log_chain ch
  WHERE ch.chain_seq = a.head_chain_seq
    AND ch.org_id IS NOT DISTINCT FROM p_org_id;
  v_seq_exists := FOUND;

  -- Populate the common output columns once.
  anchor_seq := a.anchor_seq;
  anchored_head_seq := a.head_chain_seq;
  anchored_entry_count := a.entry_count;
  live_head_seq := v_live_head_seq;
  live_entry_count := v_live_count;
  anchored_head_checksum := a.head_chain_checksum;
  live_head_checksum := v_live_head_checksum;

  -- (a0) FULLY-PRUNED chain: the live chain is now completely empty
  -- (live_head_seq=0 AND live_entry_count=0) but the anchor recorded a
  -- non-empty head. This is the benign tail of legitimate retention: when an
  -- org goes fully inactive, the retention prune (auditRetention prefix-cut,
  -- MIN()=NULL) can delete THROUGH the anchored head and empty the chain
  -- entirely. A naive seq_regressed check (below) would mis-flag this as
  -- tamper and page a P1. An empty live chain carries no rewritten/forged head
  -- to detect — there is simply nothing left — so we classify it as the benign
  -- count_shrank class (not a tamper reason) and let the job log it as a prune.
  -- A true truncation that deletes the NEWEST rows but leaves OLDER ones behind
  -- still trips seq_regressed/anchored_head_missing below (live chain non-empty
  -- with a lower head); only the fully-empty case lands here.
  IF v_live_head_seq = 0 AND v_live_count = 0
     AND (a.head_chain_seq > 0 OR a.entry_count > 0) THEN
    reason := 'count_shrank';
    RETURN NEXT;
    RETURN;
  END IF;

  -- (a) Head moved backwards. bigserial never reuses/regresses, so a lower
  -- live head than the anchored head means rows at/after the anchor's head
  -- were deleted. Strongest tamper signal. (The fully-empty special case is
  -- handled by (a0) above so it does not reach here.)
  IF v_live_head_seq < a.head_chain_seq THEN
    reason := 'seq_regressed';
    RETURN NEXT;
    RETURN;
  END IF;

  -- (b) The anchored head row is gone but the chain still advanced past it.
  -- Legitimate retention only prunes the OLDEST entries, never the head, so a
  -- vanished anchored head (when head_chain_seq>0) is truncation/rewrite.
  IF a.head_chain_seq > 0 AND NOT v_seq_exists THEN
    reason := 'anchored_head_missing';
    RETURN NEXT;
    RETURN;
  END IF;

  -- (c) The anchored head row still exists but its checksum changed → that
  -- historical entry was rewritten in place.
  IF v_seq_exists
     AND a.head_chain_checksum IS NOT NULL
     AND v_seq_checksum IS DISTINCT FROM a.head_chain_checksum THEN
    reason := 'checksum_diverged';
    RETURN NEXT;
    RETURN;
  END IF;

  -- (d) Entry count shrank but the anchored head is intact (exists + checksum
  -- matches). This is the ambiguous case: either legitimate retention pruned
  -- an older prefix, or someone deleted interior rows. We surface it as
  -- count_shrank and let the job's policy decide (retention is expected to be
  -- the cause when the anchored head verifies). Only fire when the head row is
  -- genuinely intact, otherwise (a)/(b) already returned.
  IF v_live_count < a.entry_count AND v_seq_exists THEN
    reason := 'count_shrank';
    RETURN NEXT;
    RETURN;
  END IF;

  -- Consistent: live chain is a forward extension of the anchored head. No row.
  RETURN;
END;
$$;
