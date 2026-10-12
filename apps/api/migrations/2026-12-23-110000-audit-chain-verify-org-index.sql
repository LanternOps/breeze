-- Audit-chain verify: make every org predicate index-friendly.
--
-- WHY
-- ---
-- audit_log_verify_chain (2026-06-11-h), audit_log_verify_chain_range and
-- audit_log_verify_chain_incremental (2026-10-03) all filter with
--   ch.org_id IS NOT DISTINCT FROM p_org_id
-- so that a NULL p_org_id selects the system chain. Postgres cannot use a
-- btree index for IS NOT DISTINCT FROM, so none of the (org_id, ...) indexes
-- apply and the planner falls back to walking audit_log_chain_pkey (or a seq
-- scan of audit_logs) and filtering by org. Measured on the US production
-- primary on 2026-10-12 (6.7 M chain rows, 510 orgs):
--   - min/max(chain_seq) for one small org: 33.7 s / 6.5 M buffers with
--     IS NOT DISTINCT FROM, 8 ms / 10 buffers with `=`.
--   - the nightly incremental sweep took 9.9 h (04:13Z -> 14:07Z), mean 37 s
--     per org, 13 B shared blocks read since 09-06 -- enough to evict the whole
--     buffer cache every night and drag every other query into disk reads.
--   - each 100k-row rolling re-scan block read all 100k rows of the global
--     chain_seq range for every org, not just the org's own rows.
--   - on slice-0 nights the unsealed sweep seq-scanned the 5.8 GB audit_logs
--     table once per org.
-- audit_log_seal_one already branches on NULL (`IF a.org_id IS NULL ... ELSE
-- ... = ...`) for exactly this reason; this migration carries that pattern into
-- the three verify functions. Behaviour and the (broken_id, expected, actual)
-- contract are unchanged -- the only difference is the plan.
--
-- Idempotent: CREATE OR REPLACE only. No inner BEGIN/COMMIT (autoMigrate
-- wraps each file). DDL only, so no breeze.scope election.

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
    WHERE (p_org_id IS NULL AND ch.org_id IS NULL)
       OR (p_org_id IS NOT NULL AND ch.org_id = p_org_id)
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
  -- disabled) -- flag it.
  FOR a IN
    SELECT al.* FROM audit_logs al
    WHERE ((p_org_id IS NULL AND al.org_id IS NULL)
        OR (p_org_id IS NOT NULL AND al.org_id = p_org_id))
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
  -- row's prev is the trusted anchor and is not compared -- same rule as the
  -- full walk.
  -- Branched on NULL so the backward index scan on audit_log_chain_org_seq_idx
  -- stops at the first row instead of collecting the org's whole prefix.
  IF p_org_id IS NULL THEN
    SELECT ch.chain_checksum INTO prev
    FROM audit_log_chain ch
    WHERE ch.org_id IS NULL AND ch.chain_seq < p_from_seq
    ORDER BY ch.chain_seq DESC
    LIMIT 1;
  ELSE
    SELECT ch.chain_checksum INTO prev
    FROM audit_log_chain ch
    WHERE ch.org_id = p_org_id AND ch.chain_seq < p_from_seq
    ORDER BY ch.chain_seq DESC
    LIMIT 1;
  END IF;
  is_first := NOT FOUND;

  FOR c IN
    SELECT ch.chain_seq, ch.audit_id, ch.content_checksum, ch.prev_chain_checksum,
           ch.chain_checksum
    FROM audit_log_chain ch
    WHERE ((p_org_id IS NULL AND ch.org_id IS NULL)
        OR (p_org_id IS NOT NULL AND ch.org_id = p_org_id))
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
  -- Branched on NULL so both arms use audit_log_chain_org_seq_idx
  -- (org_id, chain_seq DESC); btree supports IS NULL scans.
  IF p_org_id IS NULL THEN
    SELECT min(ch.chain_seq), max(ch.chain_seq) INTO v_min_seq, v_max_seq
    FROM audit_log_chain ch WHERE ch.org_id IS NULL;
  ELSE
    SELECT min(ch.chain_seq), max(ch.chain_seq) INTO v_min_seq, v_max_seq
    FROM audit_log_chain ch WHERE ch.org_id = p_org_id;
  END IF;

  IF v_max_seq IS NULL THEN
    -- Empty chain: the only meaningful check is for unsealed rows, and the
    -- full walk is exactly that (and cheap) when there is no chain.
    RETURN QUERY SELECT * FROM audit_log_verify_chain(p_org_id);
    RETURN;
  END IF;

  -- Second-latest anchor head for this org (latest if only one). NULL org =
  -- system chain. audit_chain_anchors is small (one row per org per night);
  -- the branch keeps audit_chain_anchors_org_seq_idx usable all the same.
  IF p_org_id IS NULL THEN
    SELECT an.head_chain_seq INTO v_anchor_head
    FROM audit_chain_anchors an WHERE an.org_id IS NULL
    ORDER BY an.anchor_seq DESC OFFSET 1 LIMIT 1;
    IF NOT FOUND THEN
      SELECT an.head_chain_seq INTO v_anchor_head
      FROM audit_chain_anchors an WHERE an.org_id IS NULL
      ORDER BY an.anchor_seq DESC LIMIT 1;
    END IF;
  ELSE
    SELECT an.head_chain_seq INTO v_anchor_head
    FROM audit_chain_anchors an WHERE an.org_id = p_org_id
    ORDER BY an.anchor_seq DESC OFFSET 1 LIMIT 1;
    IF NOT FOUND THEN
      SELECT an.head_chain_seq INTO v_anchor_head
      FROM audit_chain_anchors an WHERE an.org_id = p_org_id
      ORDER BY an.anchor_seq DESC LIMIT 1;
    END IF;
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
  -- chain_seq is the primary key, so the org predicate is only a guard here.
  SELECT ch.sealed_at - interval '1 minute' INTO v_window_start
  FROM audit_log_chain ch
  WHERE ch.chain_seq = v_from_seq
    AND ((p_org_id IS NULL AND ch.org_id IS NULL)
      OR (p_org_id IS NOT NULL AND ch.org_id = p_org_id));
  IF v_window_start IS NOT NULL THEN
    FOR a IN
      SELECT al.* FROM audit_logs al
      WHERE ((p_org_id IS NULL AND al.org_id IS NULL)
          OR (p_org_id IS NOT NULL AND al.org_id = p_org_id))
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
      WHERE ((p_org_id IS NULL AND al.org_id IS NULL)
          OR (p_org_id IS NOT NULL AND al.org_id = p_org_id))
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

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'breeze_app') THEN
    GRANT EXECUTE ON FUNCTION audit_log_verify_chain(uuid) TO breeze_app;
    GRANT EXECUTE ON FUNCTION audit_log_verify_chain_range(uuid, bigint, bigint) TO breeze_app;
    GRANT EXECUTE ON FUNCTION audit_log_verify_chain_incremental(uuid, integer, integer, bigint) TO breeze_app;
  END IF;
END $$;
