-- `billed` is an invoice lifecycle fact. Routine time/part APIs now reject it;
-- preserve only rows backed by an issued, non-void invoice line and return all
-- other historical rows to the invoice-candidate state. Report both the counts
-- and the affected ids so the rollout retains an auditable record even when no
-- suspect rows exist — the reset is not reversible from a bare count.
--
-- Lineage is `(invoice_lines.source_type, invoice_lines.source_id)` plus the
-- invoice status, and NOTHING ELSE. Deliberately no org conjunct: moveTicketOrg
-- re-stamps time_entries/ticket_parts by ticket_id with no billing_status
-- filter, while invoice_lines/invoices are excluded from that rewrite by design
-- (issued billing history keeps the org that was billed). After a ticket org
-- move the source and its invoice line legitimately sit under DIFFERENT orgs,
-- so an `il.org_id = te.org_id` conjunct would un-bill genuinely invoiced work
-- and hand it straight back to invoiceAssembly to bill a second time. source_id
-- is a UUID and the statement runs system-scoped, so the pair is already exact.
--
-- `draft` is deliberately absent from the preserved status list. issueInvoice is
-- the only writer of `billed` and sets status='sent' in the same transaction, so
-- a billed source whose only line sits on a draft is reachable only by forgery —
-- and leaving it billed would wedge that draft forever on SOURCE_ALREADY_BILLED.
-- `void` is absent because voidInvoice already releases its sources.
--
-- Both statements full-scan time_entries/ticket_parts (there is no
-- billing_status index). These are human-entered tables — thousands of rows, not
-- millions — so a single boot-time sequential scan is acceptable.

DO $$
DECLARE
  repaired_ids uuid[];
  repaired_count bigint;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  WITH repaired AS (
    UPDATE time_entries AS te
    SET billing_status = 'not_billed', updated_at = now()
    WHERE te.billing_status = 'billed'
      AND NOT EXISTS (
        SELECT 1
        FROM invoice_lines AS il
        JOIN invoices AS i ON i.id = il.invoice_id
        WHERE il.source_type = 'time_entry'
          AND il.source_id = te.id
          AND i.status IN ('sent', 'partially_paid', 'overdue', 'paid')
      )
    RETURNING te.id
  )
  SELECT COALESCE(array_agg(id), ARRAY[]::uuid[]), count(*)
  INTO repaired_ids, repaired_count
  FROM repaired;

  RAISE WARNING 'orphan billed-source repair: reset % time_entries row(s) without issued invoice lineage; ids (capped at 200): %',
    repaired_count, repaired_ids[1:200];
END $$;

DO $$
DECLARE
  repaired_ids uuid[];
  repaired_count bigint;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  WITH repaired AS (
    UPDATE ticket_parts AS tp
    SET billing_status = 'not_billed', updated_at = now()
    WHERE tp.billing_status = 'billed'
      AND NOT EXISTS (
        SELECT 1
        FROM invoice_lines AS il
        JOIN invoices AS i ON i.id = il.invoice_id
        WHERE il.source_type = 'part'
          AND il.source_id = tp.id
          AND i.status IN ('sent', 'partially_paid', 'overdue', 'paid')
      )
    RETURNING tp.id
  )
  SELECT COALESCE(array_agg(id), ARRAY[]::uuid[]), count(*)
  INTO repaired_ids, repaired_count
  FROM repaired;

  RAISE WARNING 'orphan billed-source repair: reset % ticket_parts row(s) without issued invoice lineage; ids (capped at 200): %',
    repaired_count, repaired_ids[1:200];
END $$;
