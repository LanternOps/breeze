-- Fixes two issues in 2026-05-25-b-audit-log-checksum-chain.sql:
--   (1) NEW.timestamp::text used session timezone, making the chain non-portable
--       across DB sessions. Replaced with TZ-stable to_char(... AT TIME ZONE 'UTC', ...).
--   (2) The canonical payload format was inlined in the trigger only — verifiers
--       had to re-derive it. Extracted into audit_log_canonical_payload() so the
--       trigger, verifier, and tests all share one source of truth.

-- Canonical payload helper. Takes a row of the audit_logs composite type and
-- the previous row's checksum (nullable). Marked IMMUTABLE because for a given
-- (row, prev) the output is deterministic — timestamp is serialized with
-- explicit UTC formatting, so session timezone changes don't affect the result.
CREATE OR REPLACE FUNCTION audit_log_canonical_payload(r audit_logs, prev varchar)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT
    COALESCE(prev, '') || '|' ||
    r.id::text || '|' ||
    r.actor_type::text || '|' ||
    COALESCE(r.actor_id::text, '') || '|' ||
    r.action || '|' ||
    r.resource_type || '|' ||
    COALESCE(r.resource_id::text, '') || '|' ||
    r.result::text || '|' ||
    COALESCE(r.details::text, '') || '|' ||
    to_char(r.timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
$$;

-- Rewrite the BEFORE INSERT trigger function to use the canonical helper.
-- Replaces the inlined payload assembly in 2026-05-25-b-audit-log-checksum-chain.sql.
CREATE OR REPLACE FUNCTION audit_log_compute_checksum() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  prev varchar(128);
BEGIN
  SELECT checksum INTO prev
  FROM audit_logs
  WHERE org_id IS NOT DISTINCT FROM NEW.org_id
    AND id <> NEW.id
  ORDER BY timestamp DESC, id DESC
  LIMIT 1;

  NEW.prev_checksum := prev;
  -- convert_to(... ,'UTF8'), not ::bytea — see note in -b-: the text->bytea cast
  -- throws on the backslash escapes jsonb details::text emits.
  NEW.checksum := encode(sha256(convert_to(audit_log_canonical_payload(NEW, prev), 'UTF8')), 'hex');
  RETURN NEW;
END;
$$;

-- Verifier: walks the per-org chain in (timestamp, id) order — same order the
-- BEFORE INSERT trigger establishes — and returns one row per break. A break
-- is either a checksum that doesn't match the canonical re-computation, or a
-- prev_checksum link that doesn't match the immediately preceding row.
-- Empty result set = chain is intact.
CREATE OR REPLACE FUNCTION audit_log_verify_chain(p_org_id uuid)
RETURNS TABLE (broken_id uuid, expected varchar, actual varchar)
LANGUAGE plpgsql AS $$
DECLARE
  rec audit_logs;
  prev varchar(128) := NULL;
  expected_hash varchar(128);
BEGIN
  FOR rec IN
    SELECT * FROM audit_logs
    WHERE org_id IS NOT DISTINCT FROM p_org_id
    ORDER BY timestamp, id
  LOOP
    expected_hash := encode(sha256(convert_to(audit_log_canonical_payload(rec, prev), 'UTF8')), 'hex');
    IF rec.checksum IS DISTINCT FROM expected_hash
       OR rec.prev_checksum IS DISTINCT FROM prev THEN
      broken_id := rec.id;
      expected := expected_hash;
      actual := rec.checksum;
      RETURN NEXT;
    END IF;
    prev := rec.checksum;
  END LOOP;
END;
$$;

-- Re-backfill existing rows with the corrected canonical format. The format
-- changed (timestamp serialization), so the values written by the -b- backfill
-- are stale. Re-running this migration is moot in practice — the migration
-- runner keys on filename and only applies each file once — but the loop is
-- idempotent: re-running it converges on the same checksums.
--
-- Task 1's append-only trigger (audit_log_block_update) blocks UPDATE with
-- an exception, so we DISABLE it for the duration of the backfill. The
-- migration runs inside a transaction (autoMigrate wraps each file in
-- client.begin), so a failure here rolls back the DISABLE alongside
-- everything else.
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
    -- Reset chain when crossing org boundary. Use first_iter / IS DISTINCT
    -- FROM so the very first row of either the NULL-org chain or a fresh
    -- org chain gets prev=NULL.
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
