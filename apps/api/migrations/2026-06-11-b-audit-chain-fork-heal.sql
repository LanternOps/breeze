-- Heal already-forked audit chains (issue #1002).
--
-- The -a- migration (sorts before this one) installs the advisory lock that
-- stops NEW forks. This migration re-anchors rows that already forked before
-- the lock landed: it recomputes prev_checksum/checksum for every row, per org,
-- walking each chain in (timestamp, id) order — the SAME order the BEFORE
-- INSERT trigger establishes and audit_log_verify_chain() walks. After this
-- runs, audit_log_verify_chain() returns zero breaks for every org chain
-- (absent genuine tampering, which would have changed a row's content and so
-- still surfaces as a break on the next verify against live trigger output).
--
-- Reuses audit_log_canonical_payload() — the SAME formula the trigger and
-- verifier call — so the healed checksums match what a fresh insert would
-- produce. No format drift possible.
--
-- Idempotent: re-running on an already-clean chain recomputes byte-identical
-- checksums (the canonical payload is deterministic for a fixed row + prev),
-- so the UPDATEs are no-ops in effect. Safe to re-apply.
--
-- Task 1's append-only trigger (audit_log_block_update) blocks UPDATE with an
-- exception, so DISABLE it for the duration, mirroring the -b-/-c- backfills.
-- autoMigrate wraps each file in client.begin(), so a failure rolls back the
-- DISABLE alongside everything else. No inner BEGIN;/COMMIT; (the runner owns
-- the transaction).

ALTER TABLE audit_logs DISABLE TRIGGER audit_log_block_update;

DO $$
DECLARE
  rec audit_logs;
  prev varchar(128) := NULL;
  prev_org uuid := NULL;
  first_iter boolean := true;
BEGIN
  FOR rec IN
    SELECT * FROM audit_logs ORDER BY org_id NULLS FIRST, timestamp, id
  LOOP
    -- Reset the running prev when crossing an org boundary so the first row of
    -- each per-org chain (and the NULL-org / system chain) gets prev=NULL.
    IF first_iter OR (prev_org IS DISTINCT FROM rec.org_id) THEN
      prev := NULL;
    END IF;
    first_iter := false;

    UPDATE audit_logs SET
      prev_checksum = prev,
      checksum = encode(sha256(convert_to(audit_log_canonical_payload(rec, prev), 'UTF8')), 'hex')
    WHERE id = rec.id
    RETURNING checksum INTO prev;

    prev_org := rec.org_id;
  END LOOP;
END $$;

ALTER TABLE audit_logs ENABLE TRIGGER audit_log_block_update;
