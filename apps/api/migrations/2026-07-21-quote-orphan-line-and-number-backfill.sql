-- Data-only repair for two quote defects that were fixed on the WRITE path only,
-- leaving every pre-existing row permanently broken. No DDL: no new tables, no
-- new columns, no RLS/cascade registration required.
--
-- PART A — orphan quote lines (#2553)
--   `quote_lines.block_id` is nullable. A line with block_id IS NULL renders in
--   the PDF, the portal and the preview and counts in every total, but the web
--   editor walks `quote_blocks` only, so the line is invisible AND uneditable
--   there — a quote showing a real dollar total while the builder says
--   "No content yet". `resolveLineBlockId` (quoteService.ts, v0.96.0) fixed new
--   writes; rows written before that were never repaired.
--   Repair: attach every orphan to its quote's EARLIEST line_items block,
--   creating exactly ONE such block per quote if the quote has none. Mirrors
--   resolveLineBlockId exactly: content '{}'::jsonb, sort_order =
--   COALESCE(MAX(sort_order), -1) + 1 over the quote's existing blocks.
--
-- PART B — quotes stuck with no number (#2227)
--   quote_number used to be allocated at SEND time and is nullable. Commit
--   0b718d658 (v0.92.0) moved allocation to CREATE time, but drafts created
--   before that keep quote_number = NULL forever and there is NO UI to assign
--   one — a user was left completely stuck.
--   Repair: allocate ONLY for never-sent quotes (sent_at IS NULL). A quote a
--   customer may already hold a copy of must never have its number rewritten,
--   even if that number is NULL.
--   Numbers are allocated THROUGH `partner_quote_sequences`, exactly as
--   `allocateQuoteCounter` does, so this backfill cannot collide with future
--   allocations or with the partial unique index
--   `quotes_partner_number_uq ON quotes (partner_id, quote_number) WHERE quote_number IS NOT NULL`.
--   Format matches formatQuoteNumber('Q', year, counter) -> 'Q-<year>-<0000>'.
--
-- IDEMPOTENCY: both parts are self-limiting — Part A only touches
-- block_id IS NULL, Part B only quote_number IS NULL. After one successful run
-- both predicates match nothing, so a re-run allocates no counters, creates no
-- blocks and updates no rows. Re-application is a complete no-op.
-- The ONE exception is the pathological Part B path where a quote is SKIPPED
-- after 50 colliding allocations (see below): that quote stays NULL, so a
-- re-run retries it and burns 50 more counter values. This cannot happen unless
-- a partner's sequence has fallen behind its own quote numbers, and the
-- migration RAISEs a WARNING naming the quote when it does — burning counters
-- is strictly better than aborting the whole migration on a unique violation.
--
-- No inner BEGIN;/COMMIT; — autoMigrate wraps each file in a transaction.

-- ---------------------------------------------------------------------------
-- PART A: attach orphan quote_lines to a line_items block.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  q RECORD;
  v_block_id UUID;
  v_sort_order INTEGER;
  v_blocks_created INTEGER := 0;
  v_lines_attached INTEGER := 0;
  n INTEGER;
BEGIN
  -- One iteration per affected QUOTE (not per line), so a quote with many
  -- orphans gets exactly one block, reused across all of them.
  FOR q IN
    SELECT DISTINCT ql.quote_id AS quote_id, qt.org_id AS org_id
    FROM quote_lines ql
    JOIN quotes qt ON qt.id = ql.quote_id
    WHERE ql.block_id IS NULL
    ORDER BY 1
  LOOP
    -- Earliest existing line_items block. Tiebreakers make the pick
    -- deterministic where resolveLineBlockId's bare ORDER BY sort_order is not.
    SELECT qb.id INTO v_block_id
    FROM quote_blocks qb
    WHERE qb.quote_id = q.quote_id
      AND qb.block_type = 'line_items'
    ORDER BY qb.sort_order, qb.created_at, qb.id
    LIMIT 1;

    IF v_block_id IS NULL THEN
      -- Mirrors nextBlockSortOrder(): append after every existing block.
      SELECT COALESCE(MAX(qb.sort_order), -1) + 1 INTO v_sort_order
      FROM quote_blocks qb
      WHERE qb.quote_id = q.quote_id;

      -- org_id is taken from the parent QUOTE, the authoritative tenant, not
      -- from the orphan line.
      INSERT INTO quote_blocks (quote_id, org_id, block_type, content, sort_order)
      VALUES (q.quote_id, q.org_id, 'line_items', '{}'::jsonb, v_sort_order)
      RETURNING id INTO v_block_id;

      v_blocks_created := v_blocks_created + 1;
    END IF;

    UPDATE quote_lines
    SET block_id = v_block_id
    WHERE quote_id = q.quote_id
      AND block_id IS NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
    v_lines_attached := v_lines_attached + n;
  END LOOP;

  IF v_lines_attached > 0 THEN
    RAISE WARNING 'repaired % orphan quote_lines (block_id was NULL) by attaching them to a line_items block', v_lines_attached;
  END IF;
  IF v_blocks_created > 0 THEN
    RAISE WARNING 'repaired % quotes by creating a missing line_items quote_blocks row to hold their orphan lines', v_blocks_created;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- PART B: allocate quote_number for never-sent quotes that have none.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  q RECORD;
  v_counter INTEGER;
  v_candidate VARCHAR(40);
  v_number VARCHAR(40);
  v_numbered INTEGER := 0;
  v_skipped INTEGER := 0;
  n INTEGER;
BEGIN
  FOR q IN
    SELECT id, partner_id, EXTRACT(YEAR FROM created_at)::INTEGER AS yr
    FROM quotes
    WHERE quote_number IS NULL
      AND sent_at IS NULL
    -- Oldest first within a partner so assigned numbers follow creation order.
    ORDER BY partner_id, created_at, id
  LOOP
    v_number := NULL;

    -- Same race-safe gapless allocation as allocateQuoteCounter(). The retry
    -- loop only matters if a partner's sequence counter has fallen BEHIND the
    -- numbers actually present on its quotes (e.g. a partial restore). Without
    -- it, one such collision would abort the entire migration on the unique
    -- index; with it, we burn counters until we clear the occupied range and,
    -- failing that, skip the single quote loudly.
    -- `attempt` is implicitly declared by the integer FOR loop.
    FOR attempt IN 1..50 LOOP
      INSERT INTO partner_quote_sequences (partner_id, year, counter)
      VALUES (q.partner_id, q.yr, 1)
      ON CONFLICT (partner_id, year)
      DO UPDATE SET counter = partner_quote_sequences.counter + 1
      RETURNING counter INTO v_counter;

      -- formatQuoteNumber('Q', year, counter)
      v_candidate := 'Q-' || q.yr::TEXT || '-' || LPAD(v_counter::TEXT, 4, '0');

      IF NOT EXISTS (
        SELECT 1 FROM quotes
        WHERE partner_id = q.partner_id
          AND quote_number = v_candidate
      ) THEN
        v_number := v_candidate;
        EXIT;
      END IF;
    END LOOP;

    IF v_number IS NULL THEN
      RAISE WARNING 'skipped quote % — 50 consecutive partner_quote_sequences allocations for partner %/year % were all already taken; assign a number manually', q.id, q.partner_id, q.yr;
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    -- updated_at is deliberately NOT bumped: this is a repair, and touching it
    -- would reorder every "recently updated" view for no user-visible reason.
    UPDATE quotes
    SET quote_number = v_number
    WHERE id = q.id
      AND quote_number IS NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
    v_numbered := v_numbered + n;
  END LOOP;

  IF v_numbered > 0 THEN
    RAISE WARNING 'repaired % never-sent quotes that had no quote_number by allocating one via partner_quote_sequences', v_numbered;
  END IF;
  IF v_skipped > 0 THEN
    RAISE WARNING 'left % never-sent quotes UNREPAIRED (still quote_number IS NULL) — every allocation collided with an existing number; these need manual assignment', v_skipped;
  END IF;
END $$;
