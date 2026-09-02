-- Bounded audit-chain verification (incremental + rolling re-scan).
--
-- WHY
-- ---
-- audit_log_verify_chain(org) (2026-06-11-h) walks EVERY audit_log_chain row
-- for the org, point-reads the matching audit_logs row and recomputes both
-- hashes, then makes a second anti-join pass over audit_logs for unsealed
-- rows. That is O(total chain) per org per night. Measured on the US
-- production database on 2026-09-02 (5M audit rows, 4.2 GB + 2.7 GB chain,
-- one org with 2.4M chain rows, 1 vCPU / 391 MB shared_buffers): 865 calls
-- over 66h consumed 118,000s of execution (mean 136s, max 2.2h). The daily
-- sweep ran ~13h, its random reads evicted the buffer cache (hit ratio 79%),
-- and every other query on the primary — including the postgres_exporter
-- scrape, which then tripped DOPostgresExporterDown — slowed down with it.
--
-- WHAT
-- ----
-- (1) audit_log_verify_chain_range(org, from_seq, to_seq): the chain-row
--     checks of the full walk (linkage, chain hash, content hash against the
--     live audit row) restricted to chain_seq BETWEEN from_seq AND to_seq.
--     The linkage check is seeded from the row immediately BEFORE from_seq;
--     when there is none the first row's prev is the trusted anchor, exactly
--     as the full function treats a retention-pruned prefix. It does NOT look
--     for unsealed audit rows — that is the caller's job (see below), because
--     an unsealed row has no chain_seq to be "in range".
-- (2) audit_log_verify_chain_incremental(org, slices, slice_index, block_rows):
--     the nightly plan the job runs.
--       a. INCREMENTAL — from the org's SECOND-latest anchor head to the live
--          head (the latest anchor if only one exists). The anchor job
--          (2026-06-13-c, 04:48 UTC) records the head after this job (04:13)
--          has run, so starting one anchor back means a night whose verify
--          failed or was skipped for the org is still covered the next night
--          at roughly twice the daily row cost. Starting AT the anchored row
--          (not after it) re-proves the watermark's own linkage and content.
--          An org with no anchor yet gets the full walk (new, therefore small).
--       b. UNSEALED ROWS, recent — audit_logs rows in the incremental window
--          (timestamp >= first sealed_at of the range, open-ended) that have no
--          chain row. audit_logs.timestamp can be an agent-supplied event time,
--          so this is only a fast path for the common forge (default `now()`
--          timestamp); the exhaustive check is (d).
--       c. ROLLING RE-SCAN — the chain_seq space is cut into fixed blocks of
--          `block_rows` sequence values; block b is re-verified on nights where
--          b % slices = slice_index. Block membership never moves with min/max
--          or retention, so with the job passing (utc-epoch-day % slices) every
--          historical row's content hash is re-checked at least once every
--          `slices` nights, with contiguous (cheap) ranges, no persisted cursor.
--       d. FULL UNSEALED SWEEP — on slice 0 only, the same anti-join the full
--          walk does. Once per `slices` nights per org.
--     The result contract (broken_id, expected, actual) is unchanged so the
--     job's incident path is untouched.
--
-- THREAT MODEL DELTA
-- ------------------
-- The daily full walk caught an edited audit_logs row the same night; the
-- rolling re-scan catches it within `slices` nights. Everything a forger can
-- do to the CHAIN (edit / delete / re-seal) still surfaces the same night: a
-- rewritten checksum at row k breaks row k+1's linkage inside the incremental
-- range or moves the head checksum, which audit_chain_verify_anchor() flags;
-- a forged anchor inserted to skip the incremental range (head_chain_seq
-- ahead of the live head) trips that same check as seq_regressed. breeze_app
-- cannot UPDATE or DELETE either table (REVOKE + immutability triggers), so
-- the residual window only applies to a superuser-level compromise, for
-- which the anchor is the primary control anyway.
--
-- Idempotent: CREATE OR REPLACE only. No inner BEGIN/COMMIT (autoMigrate
-- wraps each file).

CREATE OR REPLACE FUNCTION audit_log_verify_chain_range(
  p_org_id uuid,
  p_from_seq bigint,
  p_to_seq bigint
)
RETURNS TABLE (broken_id uuid, expected varchar, actual varchar)
LANGUAGE plpgsql AS $$
DECLARE
  c record;
  a audit_logs;
  prev varchar(128) := NULL;
  is_first boolean := true;
  expected_hash varchar(128);
BEGIN
  IF p_from_seq IS NULL OR p_to_seq IS NULL OR p_to_seq < p_from_seq THEN
    RETURN;
  END IF;

  -- Seed the linkage check from the row immediately before the range. When
  -- there is none (range starts at the org's first surviving entry) the first
  -- row's prev is the trusted anchor and is not compared — same rule as the
  -- full walk.
  SELECT ch.chain_checksum INTO prev
  FROM audit_log_chain ch
  WHERE ch.org_id IS NOT DISTINCT FROM p_org_id
    AND ch.chain_seq < p_from_seq
  ORDER BY ch.chain_seq DESC
  LIMIT 1;
  is_first := NOT FOUND;

  FOR c IN
    SELECT ch.chain_seq, ch.audit_id, ch.content_checksum, ch.prev_chain_checksum,
           ch.chain_checksum
    FROM audit_log_chain ch
    WHERE ch.org_id IS NOT DISTINCT FROM p_org_id
      AND ch.chain_seq BETWEEN p_from_seq AND p_to_seq
    ORDER BY ch.chain_seq
  LOOP
    -- Linkage.
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
END;
$$;

CREATE OR REPLACE FUNCTION audit_log_verify_chain_incremental(
  p_org_id uuid,
  p_slices integer DEFAULT 30,
  p_slice_index integer DEFAULT 0,
  p_block_rows bigint DEFAULT 100000
)
RETURNS TABLE (broken_id uuid, expected varchar, actual varchar)
LANGUAGE plpgsql AS $$
DECLARE
  a audit_logs;
  v_anchor_head bigint;
  v_min_seq bigint;
  v_max_seq bigint;
  v_from_seq bigint;
  v_window_start timestamptz;
  v_slices integer := GREATEST(COALESCE(p_slices, 30), 1);
  v_slice integer := ((COALESCE(p_slice_index, 0) % GREATEST(COALESCE(p_slices, 30), 1))
                      + GREATEST(COALESCE(p_slices, 30), 1)) % GREATEST(COALESCE(p_slices, 30), 1);
  v_block bigint := GREATEST(COALESCE(p_block_rows, 100000), 1);
  v_block_no bigint;
  v_block_from bigint;
  v_block_to bigint;
BEGIN
  SELECT min(ch.chain_seq), max(ch.chain_seq) INTO v_min_seq, v_max_seq
  FROM audit_log_chain ch
  WHERE ch.org_id IS NOT DISTINCT FROM p_org_id;

  IF v_max_seq IS NULL THEN
    -- Empty chain: the only meaningful check is for unsealed rows, and the
    -- full walk is exactly that (and cheap) when there is no chain.
    RETURN QUERY SELECT * FROM audit_log_verify_chain(p_org_id);
    RETURN;
  END IF;

  -- Second-latest anchor head for this org (latest if only one). NULL org =
  -- system chain.
  SELECT an.head_chain_seq INTO v_anchor_head
  FROM audit_chain_anchors an
  WHERE an.org_id IS NOT DISTINCT FROM p_org_id
  ORDER BY an.anchor_seq DESC
  OFFSET 1 LIMIT 1;
  IF NOT FOUND THEN
    SELECT an.head_chain_seq INTO v_anchor_head
    FROM audit_chain_anchors an
    WHERE an.org_id IS NOT DISTINCT FROM p_org_id
    ORDER BY an.anchor_seq DESC
    LIMIT 1;
  END IF;

  IF v_anchor_head IS NULL THEN
    -- No watermark yet: new org, walk it all.
    RETURN QUERY SELECT * FROM audit_log_verify_chain(p_org_id);
    RETURN;
  END IF;

  -- (a) Incremental: from the anchored row itself to the live head. Clamped
  -- into [min, max] so a retention-pruned anchor starts at the first surviving
  -- row and a forged, ahead-of-head anchor still verifies the live head (the
  -- anchor job pages on that anchor separately).
  v_from_seq := LEAST(GREATEST(v_anchor_head, v_min_seq), v_max_seq);
  RETURN QUERY
    SELECT * FROM audit_log_verify_chain_range(p_org_id, v_from_seq, v_max_seq);

  -- (b) Recent unsealed rows: anything stamped at or after the start of the
  -- incremental window (1 minute of slack for the transaction-start vs
  -- commit skew between audit_logs.timestamp and sealed_at) with no chain row.
  SELECT ch.sealed_at - interval '1 minute' INTO v_window_start
  FROM audit_log_chain ch
  WHERE ch.org_id IS NOT DISTINCT FROM p_org_id AND ch.chain_seq = v_from_seq;
  IF v_window_start IS NOT NULL THEN
    FOR a IN
      SELECT al.* FROM audit_logs al
      WHERE al.org_id IS NOT DISTINCT FROM p_org_id
        AND al.timestamp >= v_window_start
        AND NOT EXISTS (SELECT 1 FROM audit_log_chain ch WHERE ch.audit_id = al.id)
      ORDER BY al.timestamp, al.id
    LOOP
      broken_id := a.id; expected := 'sealed'; actual := NULL;
      RETURN NEXT;
    END LOOP;
  END IF;

  -- (c) Rolling re-scan of the historical chain strictly below the anchored
  -- row, in fixed blocks of the global chain_seq space. Block b is due when
  -- b % slices = slice.
  IF v_anchor_head > v_min_seq THEN
    v_block_no := v_min_seq / v_block;
    WHILE v_block_no * v_block < v_anchor_head LOOP
      IF v_block_no % v_slices = v_slice THEN
        v_block_from := GREATEST(v_block_no * v_block, v_min_seq);
        v_block_to := LEAST((v_block_no + 1) * v_block - 1, v_anchor_head - 1);
        IF v_block_to >= v_block_from THEN
          RETURN QUERY
            SELECT * FROM audit_log_verify_chain_range(p_org_id, v_block_from, v_block_to);
        END IF;
      END IF;
      v_block_no := v_block_no + 1;
    END LOOP;
  END IF;

  -- (d) Exhaustive unsealed sweep once per cycle (slice 0): the same anti-join
  -- the full walk performs, for rows whose timestamp is outside window (b).
  IF v_slice = 0 THEN
    FOR a IN
      SELECT al.* FROM audit_logs al
      WHERE al.org_id IS NOT DISTINCT FROM p_org_id
        AND (v_window_start IS NULL OR al.timestamp < v_window_start)
        AND NOT EXISTS (SELECT 1 FROM audit_log_chain ch WHERE ch.audit_id = al.id)
      ORDER BY al.timestamp, al.id
    LOOP
      broken_id := a.id; expected := 'sealed'; actual := NULL;
      RETURN NEXT;
    END LOOP;
  END IF;
END;
$$;

-- breeze_app runs the nightly job under the system context; function EXECUTE
-- is granted to PUBLIC by default so this is belt-and-braces only.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'breeze_app') THEN
    GRANT EXECUTE ON FUNCTION audit_log_verify_chain_range(uuid, bigint, bigint) TO breeze_app;
    GRANT EXECUTE ON FUNCTION audit_log_verify_chain_incremental(uuid, integer, integer, bigint) TO breeze_app;
  END IF;
END $$;
