-- Fix issue #1002: audit hash-chain forks under concurrent same-org inserts.
--
-- The BEFORE INSERT trigger audit_log_compute_checksum() (canonical version in
-- 2026-05-25-c-audit-log-checksum-canonical-fix.sql) reads its predecessor
-- checksum with a plain SELECT and no serialization. Under concurrent inserts
-- into the same org chain, each transaction reads the SAME latest *committed*
-- checksum as `prev` (it cannot see the other in-flight transactions'
-- uncommitted rows), so all of them link back to the same predecessor. The
-- per-org chain forks, and audit_log_verify_chain() then reports
-- false-positive breaks even though no row was tampered or deleted. Confirmed
-- in production (US droplet, v0.68.2). No data loss — only the tamper-detection
-- signal degrades.
--
-- Fix: take a transaction-scoped advisory lock keyed on the chain's org_id
-- BEFORE selecting the predecessor. pg_advisory_xact_lock auto-releases at
-- commit/rollback, so concurrent same-org inserts serialize through the
-- read-prev / assign-checksum critical section and each one picks up the
-- previously-committed row in turn. Different orgs hash to different lock keys
-- and proceed in parallel.
--
-- This is a CREATE OR REPLACE of the EXACT canonical function from the -c-
-- migration, with only the advisory-lock PERFORM added before the predecessor
-- SELECT. All other logic — including the convert_to(...,'UTF8') canonicalization
-- from #994 (NOT ::bytea) and the audit_log_canonical_payload() call — is
-- preserved byte-for-byte. Idempotent by construction (CREATE OR REPLACE).
--
-- Lock namespace: pg_advisory_xact_lock(key1 int, key2 int). We use a fixed
-- project-stable namespace integer for key1 so this chain lock never collides
-- with advisory locks taken elsewhere, and hashtext(org_id) for key2. The
-- namespace value 1000200 is derived from the issue number (#1002) and is
-- reserved exclusively for the audit-chain per-org lock.

CREATE OR REPLACE FUNCTION audit_log_compute_checksum() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  prev varchar(128);
  prev_ts timestamp;
BEGIN
  -- Issue #1002: serialize concurrent same-org inserts through the
  -- predecessor read so the chain cannot fork. Namespace 1000200 is reserved
  -- for the audit-log per-org chain lock; the second key hashes the chain's
  -- org_id (COALESCE to a sentinel so the NULL-org / system chain also
  -- serializes on its own key). pg_advisory_xact_lock releases automatically
  -- when this transaction commits or rolls back.
  PERFORM pg_advisory_xact_lock(1000200, hashtext(COALESCE(NEW.org_id::text, 'NULL')));

  -- Pick the current chain head: the most recent committed row in this org's
  -- chain by the SAME (timestamp, id) total order audit_log_verify_chain walks
  -- (DESC here = the max under that order). Grab its timestamp too so we can
  -- keep the chain key monotonic below.
  SELECT checksum, timestamp INTO prev, prev_ts
  FROM audit_logs
  WHERE org_id IS NOT DISTINCT FROM NEW.org_id
    AND id <> NEW.id
  ORDER BY timestamp DESC, id DESC
  LIMIT 1;

  -- Monotonicity guard (issue #1002). audit_logs.timestamp defaults to now()
  -- = transaction_timestamp(), which is the transaction *start* time and is
  -- constant within a transaction. Under concurrency the advisory lock
  -- serializes the critical section, but a transaction that STARTED earlier
  -- can acquire the lock LATER, so its (earlier) transaction_timestamp would
  -- insert a row that sorts BEFORE the current chain head under (timestamp,
  -- id) — re-forking the chain the verifier reconstructs. Because we hold the
  -- per-org lock, clock_timestamp() is strictly increasing across serialized
  -- inserts, so nudging NEW.timestamp just past the head restores a total
  -- order that matches lock/commit order. In the common non-concurrent case
  -- the head is older than now() and this branch is a no-op, preserving the
  -- caller's real timestamp.
  IF prev_ts IS NOT NULL AND NEW.timestamp <= prev_ts THEN
    NEW.timestamp := GREATEST(clock_timestamp()::timestamp, prev_ts + interval '1 microsecond');
  END IF;

  NEW.prev_checksum := prev;
  -- convert_to(... ,'UTF8'), not ::bytea — see note in -b-: the text->bytea cast
  -- throws on the backslash escapes jsonb details::text emits.
  NEW.checksum := encode(sha256(convert_to(audit_log_canonical_payload(NEW, prev), 'UTF8')), 'hex');
  RETURN NEW;
END;
$$;
