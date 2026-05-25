-- Populate audit_logs.checksum as a per-org SHA-256 hash chain so deleted
-- or tampered rows produce a verifiable gap. Task 1 (the -a- migration
-- on this date) made the table append-only at the DB layer; this -b-
-- migration adds the tamper-evident chain. Chain key is org_id (NULL
-- for system-scoped events) so org-scoped retention pruning rebuilds
-- only the affected chain.

ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS prev_checksum varchar(128);

CREATE OR REPLACE FUNCTION audit_log_compute_checksum() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  prev varchar(128);
  payload text;
BEGIN
  -- Look up the latest existing row in this org's chain. `IS NOT DISTINCT
  -- FROM` matches NULL-to-NULL so system-scoped (NULL org_id) events form
  -- their own chain. The trigger fires BEFORE INSERT, so NEW.id is set
  -- but the row is not yet in the table; the `id <> NEW.id` guard is
  -- defensive in case a future ALTER fires AFTER.
  SELECT checksum INTO prev
  FROM audit_logs
  WHERE org_id IS NOT DISTINCT FROM NEW.org_id
    AND id <> NEW.id
  ORDER BY timestamp DESC, id DESC
  LIMIT 1;

  -- Stable canonical payload — column order matches the backfill below.
  -- `details::text` is deterministic for jsonb (Postgres normalises key
  -- ordering and whitespace). `timestamp::text` uses the session
  -- timezone, but the backfill computes against the same DB so the
  -- representation is consistent.
  payload := COALESCE(prev, '') || '|'
          || NEW.id::text || '|'
          || NEW.actor_type::text || '|'
          || COALESCE(NEW.actor_id::text, '') || '|'
          || NEW.action || '|'
          || NEW.resource_type || '|'
          || COALESCE(NEW.resource_id::text, '') || '|'
          || NEW.result::text || '|'
          || COALESCE(NEW.details::text, '') || '|'
          || NEW.timestamp::text;

  NEW.prev_checksum := prev;
  NEW.checksum := encode(sha256(payload::bytea), 'hex');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS audit_log_chain_checksum ON audit_logs;
CREATE TRIGGER audit_log_chain_checksum BEFORE INSERT ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_log_compute_checksum();

-- Backfill: populate prev_checksum/checksum for existing rows in per-org
-- timestamp order. Task 1's append-only trigger (audit_log_block_update)
-- blocks UPDATE statements with an exception, so we DISABLE it for the
-- duration of the backfill. The migration runs inside a transaction
-- (autoMigrate wraps each file in client.begin), so a failure here
-- rolls back the DISABLE alongside everything else.
ALTER TABLE audit_logs DISABLE TRIGGER audit_log_block_update;

DO $$
DECLARE
  rec record;
  prev varchar(128) := NULL;
  prev_org uuid := NULL;
  first_iter boolean := true;
BEGIN
  FOR rec IN
    SELECT id, org_id, actor_type, actor_id, action, resource_type, resource_id, result, details, timestamp
    FROM audit_logs
    ORDER BY org_id NULLS FIRST, timestamp, id
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
      checksum = encode(sha256((
        COALESCE(prev, '') || '|' || rec.id::text || '|' || rec.actor_type::text || '|' ||
        COALESCE(rec.actor_id::text, '') || '|' || rec.action || '|' || rec.resource_type || '|' ||
        COALESCE(rec.resource_id::text, '') || '|' || rec.result::text || '|' ||
        COALESCE(rec.details::text, '') || '|' || rec.timestamp::text
      )::bytea), 'hex')
    WHERE id = rec.id
    RETURNING checksum INTO prev;

    prev_org := rec.org_id;
  END LOOP;
END $$;

ALTER TABLE audit_logs ENABLE TRIGGER audit_log_block_update;
