-- Sweep C4 (v0.116 pre-release sweep) + settings audit rule 6: freeze the
-- "Ticket #…" label an invoice line prints at the moment the invoice is issued.
--
-- Before this migration every render joined tickets live with
-- COALESCE(ticket_number, internal_number). ticket_number is the NOT NULL legacy
-- random id, so issued documents printed e.g. "Ticket #QIMK3YNBYR". New code
-- prints the human internal_number (T-2026-0001) on drafts and stamps it into
-- invoice_lines.ticket_label at issue (invoiceService.issueInvoice).
--
-- Semantics: NULL on a draft line = read the ticket's live number. A non-draft
-- line renders ticket_label only.
--
-- Backfill: every line of a NON-draft invoice that links a live, same-org
-- ticket takes exactly what it printed before this change —
-- COALESCE(ticket_number, internal_number), the same join predicate the old
-- readers used (ticket org = invoice org, not soft-deleted) — so documents
-- customers already received keep their label. Lines whose ticket did not join
-- printed no label and stay NULL. The UPDATE runs in 5000-row chunks, which
-- bounds each statement's size only: autoMigrate wraps this file in ONE
-- transaction, so every updated row stays locked until the file commits.
-- Counted; idempotent — a re-run finds nothing left to stamp and reports nothing.

-- Elect system scope BEFORE any tenant-row write: invoice_lines is FORCE ROW
-- LEVEL SECURITY, and without this the UPDATE matches zero rows silently (#4518).
SELECT set_config('breeze.scope', 'system', true);

ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS ticket_label varchar(50);

DO $$
DECLARE
  n integer;
  total bigint := 0;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  LOOP
    -- ticket_number is NOT NULL, so every batched row gets a non-NULL label and
    -- drops out of the next batch: the loop always makes progress.
    UPDATE invoice_lines il
    SET ticket_label = b.label
    FROM (
      SELECT l.id, COALESCE(t.ticket_number, t.internal_number) AS label
      FROM invoice_lines l
      JOIN invoices i ON i.id = l.invoice_id
      JOIN tickets t ON t.id = l.ticket_id AND t.org_id = i.org_id AND t.deleted_at IS NULL
      WHERE l.ticket_label IS NULL AND i.status <> 'draft'
      ORDER BY l.id
      LIMIT 5000
    ) b
    WHERE il.id = b.id;
    GET DIAGNOSTICS n = ROW_COUNT;
    EXIT WHEN n = 0;
    total := total + n;
  END LOOP;
  IF total > 0 THEN
    RAISE WARNING 'invoice-ticket-label: backfilled ticket_label on % issued invoice lines with the legacy label they printed', total;
  END IF;
END $$;
