-- #6227 (settings consolidation W04, parent #6223): freeze an invoice's
-- presentation (theme + page size) at issue — settings audit rule 6, "one
-- snapshot moment".
--
-- Before this migration every invoice render read the partner's LIVE
-- partners.document_theme / document_page_size, so a partner changing its
-- default reflowed documents customers had already been shown. Quotes already
-- freeze this at send (quotes.presentation_snapshot); invoices get two typed
-- scalar columns instead of JSONB (quorum amendment 1: stable enums, CHECK-able,
-- exportable as ordinary data).
--
-- Semantics: NULL on a draft = preview the partner's live values. Both issue
-- writers (invoiceService.issueInvoice and the quote-accept direct issue)
-- stamp the RESOLVED values; renderers read them via resolveInvoicePresentation.
--
-- Backfill: every NON-draft invoice with a NULL column takes its partner's
-- CURRENT value — exactly what that invoice renders today, so no customer-
-- visible output changes. The CASE mirrors resolveThemeId / resolvePageSize
-- (documentThemes.ts): anything but 'condensed' → 'classic', anything but
-- 'letter' → 'a4'. Batched (5000 rows per UPDATE) and counted; idempotent —
-- a re-run finds no NULL non-draft rows and reports nothing.

-- Elect system scope BEFORE any tenant-row write: invoices is FORCE ROW LEVEL
-- SECURITY, and without this the UPDATE matches zero rows silently (#4518).
SELECT set_config('breeze.scope', 'system', true);

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS document_theme varchar(16);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS document_page_size varchar(8);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_document_theme_chk') THEN
    ALTER TABLE invoices ADD CONSTRAINT invoices_document_theme_chk
      CHECK (document_theme IS NULL OR document_theme IN ('classic', 'condensed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_document_page_size_chk') THEN
    ALTER TABLE invoices ADD CONSTRAINT invoices_document_page_size_chk
      CHECK (document_page_size IS NULL OR document_page_size IN ('letter', 'a4'));
  END IF;
END $$;

DO $$
DECLARE
  n integer;
  total bigint := 0;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  LOOP
    -- Scalar subqueries (not a join) so a row ALWAYS gets a value and the loop
    -- always makes progress, even if a partner row were somehow unreadable.
    UPDATE invoices i
    SET
      document_theme = COALESCE(i.document_theme,
        CASE WHEN (SELECT p.document_theme FROM partners p WHERE p.id = i.partner_id) = 'condensed'
          THEN 'condensed' ELSE 'classic' END),
      document_page_size = COALESCE(i.document_page_size,
        CASE WHEN (SELECT p.document_page_size FROM partners p WHERE p.id = i.partner_id) = 'letter'
          THEN 'letter' ELSE 'a4' END)
    WHERE i.id IN (
      SELECT b.id FROM invoices b
      WHERE b.status <> 'draft' AND (b.document_theme IS NULL OR b.document_page_size IS NULL)
      ORDER BY b.id
      LIMIT 5000
    );
    GET DIAGNOSTICS n = ROW_COUNT;
    EXIT WHEN n = 0;
    total := total + n;
  END LOOP;
  IF total > 0 THEN
    RAISE WARNING 'invoice-presentation: backfilled document_theme/document_page_size on % non-draft invoices from partner defaults', total;
  END IF;
END $$;
