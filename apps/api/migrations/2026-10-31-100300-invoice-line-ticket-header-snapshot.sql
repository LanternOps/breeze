-- #6955 / #6674 (settings audit rule 6): freeze the ticket SUBJECT and CATEGORY
-- an invoice line's group header prints at the moment the invoice is issued —
-- the same contract invoice_lines.ticket_label follows (2026-10-30-140000).
--
-- Before this migration every render joined tickets / ticket_categories live,
-- so renaming, recategorising, soft-deleting or org-moving a ticket rewrote the
-- headers of invoices the customer already received. The authenticated portal
-- (org scope) could not see ticket_categories (partner-axis RLS) at all and
-- printed no category on any invoice.
--
-- Semantics: NULL on a draft line = read the ticket live. A non-draft line
-- renders ticket_subject / ticket_category only (invoiceService.issueInvoice
-- stamps them).
--
-- Backfill: every line of a NON-draft invoice that links a live, same-org
-- ticket takes exactly what the PDF / web / public view printed before this
-- change — tickets.subject and COALESCE(ticket_categories.name,
-- tickets.category), the same join predicate the old readers used (ticket org =
-- invoice org, not soft-deleted). Lines whose ticket did not join printed no
-- header and stay NULL. The UPDATE runs in 5000-row chunks, which bounds each
-- statement's size only: autoMigrate wraps this file in ONE transaction.
-- Counted; idempotent — tickets.subject is NOT NULL, so a stamped row drops out
-- of the `ticket_subject IS NULL` filter and a re-run reports nothing.

-- Elect system scope BEFORE any tenant-row write: invoice_lines and
-- ticket_categories are FORCE ROW LEVEL SECURITY (#4518).
SELECT set_config('breeze.scope', 'system', true);

ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS ticket_subject varchar(255);
ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS ticket_category varchar(100);

DO $$
DECLARE
  n integer;
  total bigint := 0;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  LOOP
    UPDATE invoice_lines il
    SET ticket_subject = b.subject,
        ticket_category = b.category
    FROM (
      SELECT l.id, t.subject, COALESCE(tc.name, t.category) AS category
      FROM invoice_lines l
      JOIN invoices i ON i.id = l.invoice_id
      JOIN tickets t ON t.id = l.ticket_id AND t.org_id = i.org_id AND t.deleted_at IS NULL
      LEFT JOIN ticket_categories tc ON tc.id = t.category_id
      WHERE l.ticket_subject IS NULL AND i.status <> 'draft'
      ORDER BY l.id
      LIMIT 5000
    ) b
    WHERE il.id = b.id;
    GET DIAGNOSTICS n = ROW_COUNT;
    EXIT WHEN n = 0;
    total := total + n;
  END LOOP;
  IF total > 0 THEN
    RAISE WARNING 'invoice-ticket-header: backfilled ticket subject/category on % issued invoice lines with what they printed', total;
  END IF;
END $$;
