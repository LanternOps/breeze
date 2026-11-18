-- #10361 — DURABLE QUOTE → CONTRACT LINK.
--
-- WHY. Accepting a quote with monthly/annual lines creates one DRAFT contract
-- per cadence, but nothing durable recorded which quote produced it:
-- contract_lines deliberately do not persist the source quote line, and the
-- only existing link (contract_documents.quote_id/contract_id) exists only when
-- the quote embedded an agreement block, and then names only the FIRST
-- contract. So the accepted quote could not point at its contracts, and the
-- contracts list could not tell a quote's pending draft from a hand-started one.
--
-- source_quote_id is that link. Nullable: hand-built and adopted contracts have
-- no source quote. Same-tenant by the composite FK onto quotes_id_org_uq.
-- ON DELETE SET NULL (source_quote_id) clears only the pointer when the quote is
-- deleted — org_id is NOT NULL and must never be nulled. DEFERRABLE INITIALLY
-- IMMEDIATE because org merge re-points quotes.org_id and contracts.org_id in
-- separate statements under SET CONSTRAINTS ALL DEFERRED (docs/agents/tenancy-rls.md).
--
-- Idempotent; no inner BEGIN/COMMIT (autoMigrate wraps each file).

ALTER TABLE contracts ADD COLUMN IF NOT EXISTS source_quote_id uuid;

DO $$ BEGIN
  ALTER TABLE contracts ADD CONSTRAINT contracts_source_quote_org_fkey
    FOREIGN KEY (source_quote_id, org_id)
    REFERENCES quotes (id, org_id) ON DELETE SET NULL (source_quote_id)
    DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS contracts_source_quote_idx
  ON contracts (source_quote_id) WHERE source_quote_id IS NOT NULL;

-- Backfill what can be attributed without guessing. Writes need system scope
-- under FORCE ROW LEVEL SECURITY (migrations/README.md, "Writing rows").
SELECT set_config('breeze.scope', 'system', true);

-- (1) The executed agreement a quote accept froze against its first contract.
--     Only quote-sourced documents (an agreement request has no quote), and
--     only same-org pairs — the FK above would reject anything else anyway.
DO $$
DECLARE n bigint;
BEGIN
  UPDATE contracts c
     SET source_quote_id = d.quote_id
    FROM (
      SELECT DISTINCT ON (contract_id) contract_id, quote_id, org_id
        FROM contract_documents
       WHERE source_kind = 'quote'
         AND quote_id IS NOT NULL
         AND contract_id IS NOT NULL
       ORDER BY contract_id, created_at
    ) d
   WHERE c.id = d.contract_id
     AND c.org_id = d.org_id
     AND c.source_quote_id IS NULL
     AND EXISTS (SELECT 1 FROM quotes q WHERE q.id = d.quote_id AND q.org_id = c.org_id);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'backfilled % contract source_quote_id row(s) from contract_documents', n;
  END IF;
END $$;

-- (2) A Pax8 order staged by the same accept: its lines name the contract line
--     each quote line became, and the order names the quote. Covers the annual
--     (second) contract and quotes with no agreement block.
DO $$
DECLARE n bigint;
BEGIN
  UPDATE contracts c
     SET source_quote_id = src.quote_id
    FROM (
      SELECT DISTINCT ON (cl.contract_id) cl.contract_id, o.source_quote_id AS quote_id, o.org_id
        FROM pax8_order_lines ol
        JOIN pax8_orders o ON o.id = ol.order_id AND o.org_id = ol.org_id
        JOIN contract_lines cl ON cl.id = ol.contract_line_id AND cl.org_id = ol.org_id
       WHERE o.source_quote_id IS NOT NULL
       ORDER BY cl.contract_id, o.created_at
    ) src
   WHERE c.id = src.contract_id
     AND c.org_id = src.org_id
     AND c.source_quote_id IS NULL
     AND EXISTS (SELECT 1 FROM quotes q WHERE q.id = src.quote_id AND q.org_id = c.org_id);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'backfilled % contract source_quote_id row(s) from pax8 orders', n;
  END IF;
END $$;
