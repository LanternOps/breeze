-- Issue #1002 (part 2 of 2): deferred commit-time sealing + verify v2.
--
-- 1. audit_log_compute_checksum (BEFORE INSERT) becomes content-only: no
--    predecessor read, no lock, prev_checksum := NULL. Linkage moves to the
--    audit_log_chain side table (the -g- migration).
-- 2. audit_log_seal_one(row) appends a chain entry under a per-org advisory
--    lock; the DEFERRED constraint trigger calls it at COMMIT, so the lock is
--    held only through commit processing — never across application awaits.
--    (The held-to-commit variant deadlocks; see draft PR #1240 and the design
--    spec docs/superpowers/specs/2026-06-11-audit-chain-deferred-sealing-design.md.)
-- 3. Backfill seals every existing audit row per org in (timestamp, id) order,
--    ignoring the legacy (possibly forked) prev_checksum values entirely.
-- 4. audit_log_verify_chain keeps its signature but walks the side table.
--
-- Lock namespace 1000200 (from issue #1002) is reserved for this chain lock.

-- (1) Content-only BEFORE INSERT trigger. Reuses audit_log_canonical_payload
-- from 2026-05-25-c with prev := NULL. convert_to(...,'UTF8'), not ::bytea —
-- the cast throws on the backslash escapes jsonb details::text emits (#994).
CREATE OR REPLACE FUNCTION audit_log_compute_checksum() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.prev_checksum := NULL;
  NEW.checksum := encode(sha256(convert_to(audit_log_canonical_payload(NEW, NULL), 'UTF8')), 'hex');
  RETURN NEW;
END;
$$;
-- The existing trigger audit_log_chain_checksum (BEFORE INSERT, from -b-)
-- already points at this function; CREATE OR REPLACE rebinds it in place.

-- (2) Seal one audit row into the chain. Shared by the commit-time trigger and
-- the backfill loop below. SECURITY INVOKER: runs under the inserting caller's
-- RLS context — the chain row's org matches the audit row's org, so the
-- standard shape-1 WITH CHECK passes for exactly the callers that could insert
-- the audit row in the first place.
CREATE OR REPLACE FUNCTION audit_log_seal_one(a audit_logs) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  prev_chain varchar(128);
  content varchar(128);
BEGIN
  -- Serialize same-org seals. At commit time this is held only through the
  -- remaining commit processing (sub-ms), so the #1240 two-connection deadlock
  -- cannot occur. Reentrant for multi-row same-org batches in one tx.
  PERFORM pg_advisory_xact_lock(1000200, hashtext(COALESCE(a.org_id::text, 'NULL')));

  -- Head lookup, branched on NULL so both arms are index-friendly
  -- (audit_log_chain_org_seq_idx; btree supports IS NULL scans).
  IF a.org_id IS NULL THEN
    SELECT chain_checksum INTO prev_chain
    FROM audit_log_chain WHERE org_id IS NULL
    ORDER BY chain_seq DESC LIMIT 1;
  ELSE
    SELECT chain_checksum INTO prev_chain
    FROM audit_log_chain WHERE org_id = a.org_id
    ORDER BY chain_seq DESC LIMIT 1;
  END IF;

  -- Content hash recomputed from the row (NOT read from a.checksum): uniform
  -- for backfilled legacy rows (whose stored checksum is the old chained
  -- value) and new rows alike, and keeps the chain independent of the
  -- vestigial in-row columns.
  content := encode(sha256(convert_to(audit_log_canonical_payload(a, NULL), 'UTF8')), 'hex');

  INSERT INTO audit_log_chain (audit_id, org_id, content_checksum, prev_chain_checksum, chain_checksum)
  VALUES (
    a.id,
    a.org_id,
    content,
    prev_chain,
    encode(sha256(convert_to(COALESCE(prev_chain, '') || '|' || content, 'UTF8')), 'hex')
  );
END;
$$;

-- Commit-time wrapper.
CREATE OR REPLACE FUNCTION audit_log_seal_chain() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM audit_log_seal_one(NEW);
  RETURN NULL;
END;
$$;

-- Constraint triggers are the only trigger kind that can defer to COMMIT.
DROP TRIGGER IF EXISTS audit_log_chain_seal ON audit_logs;
CREATE CONSTRAINT TRIGGER audit_log_chain_seal
  AFTER INSERT ON audit_logs
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION audit_log_seal_chain();

-- (3) Backfill: seal every not-yet-sealed audit row, per org, in (timestamp,
-- id) order. NOT EXISTS guard makes re-application a no-op, and also seals any
-- straggler rows written by a not-yet-migrated API instance between -g- and
-- -h- on a rolling deploy.
DO $$
DECLARE
  rec audit_logs;
BEGIN
  FOR rec IN
    SELECT a.* FROM audit_logs a
    WHERE NOT EXISTS (SELECT 1 FROM audit_log_chain c WHERE c.audit_id = a.id)
    ORDER BY a.org_id NULLS FIRST, a.timestamp, a.id
  LOOP
    PERFORM audit_log_seal_one(rec);
  END LOOP;
END $$;

-- (4) Verify v2 — SAME signature as -c- (cron + tests call it unchanged) —
-- but walks the side table. Flags, in chain_seq order:
--   linkage break, chain-hash mismatch, content tamper (recomputed from the
--   live audit row), dangling seal (audit row gone), and finally any UNSEALED
--   audit row (a deleted chain entry). The FIRST surviving entry's prev is the
--   trusted anchor: NULL for a virgin chain, or a reference to legitimately
--   retention-pruned history — there is deliberately no re-anchor rewrite
--   (rewriting the head's chain_checksum would invalidate its successor's
--   stored prev; see the design spec).
CREATE OR REPLACE FUNCTION audit_log_verify_chain(p_org_id uuid)
RETURNS TABLE (broken_id uuid, expected varchar, actual varchar)
LANGUAGE plpgsql AS $$
DECLARE
  c record;
  a audit_logs;
  prev varchar(128) := NULL;
  is_first boolean := true;
  expected_hash varchar(128);
BEGIN
  FOR c IN
    SELECT ch.chain_seq, ch.audit_id, ch.content_checksum, ch.prev_chain_checksum, ch.chain_checksum
    FROM audit_log_chain ch
    WHERE ch.org_id IS NOT DISTINCT FROM p_org_id
    ORDER BY ch.chain_seq
  LOOP
    -- Linkage. The FIRST surviving entry's prev is the trusted anchor (NULL =
    -- virgin chain; non-NULL = retention pruned the prefix), so it is not
    -- compared. Every later entry must reference its immediate predecessor.
    IF NOT is_first AND c.prev_chain_checksum IS DISTINCT FROM prev THEN
      broken_id := c.audit_id; expected := prev; actual := c.prev_chain_checksum;
      RETURN NEXT;
    END IF;
    is_first := false;

    -- Chain-hash integrity.
    expected_hash := encode(sha256(convert_to(
      COALESCE(c.prev_chain_checksum, '') || '|' || c.content_checksum, 'UTF8')), 'hex');
    IF c.chain_checksum IS DISTINCT FROM expected_hash THEN
      broken_id := c.audit_id; expected := expected_hash; actual := c.chain_checksum;
      RETURN NEXT;
    END IF;

    -- Content integrity, recomputed from the live audit row.
    SELECT * INTO a FROM audit_logs WHERE id = c.audit_id;
    IF NOT FOUND THEN
      broken_id := c.audit_id; expected := c.content_checksum; actual := NULL;
      RETURN NEXT;
    ELSE
      expected_hash := encode(sha256(convert_to(audit_log_canonical_payload(a, NULL), 'UTF8')), 'hex');
      IF expected_hash IS DISTINCT FROM c.content_checksum THEN
        broken_id := c.audit_id; expected := expected_hash; actual := c.content_checksum;
        RETURN NEXT;
      END IF;
    END IF;

    prev := c.chain_checksum;
  END LOOP;

  -- Unsealed audit rows: every committed row gets a seal atomically, so a
  -- missing entry means the chain row was deleted (or the seal trigger was
  -- disabled) — flag it.
  FOR a IN
    SELECT al.* FROM audit_logs al
    WHERE al.org_id IS NOT DISTINCT FROM p_org_id
      AND NOT EXISTS (SELECT 1 FROM audit_log_chain ch WHERE ch.audit_id = al.id)
    ORDER BY al.timestamp, al.id
  LOOP
    broken_id := a.id;
    expected := 'sealed';
    actual := NULL;
    RETURN NEXT;
  END LOOP;
END;
$$;
