-- `billed` is an invoice lifecycle fact. Routine time/part APIs now reject it;
-- preserve only rows backed by an issued, non-void invoice line and return all
-- other historical rows to the invoice-candidate state. Report both counts so
-- the rollout retains an auditable record even when no suspect rows exist.

DO $$
DECLARE
  repaired_count bigint;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  UPDATE time_entries AS te
  SET billing_status = 'not_billed', updated_at = now()
  WHERE te.billing_status = 'billed'
    AND NOT EXISTS (
      SELECT 1
      FROM invoice_lines AS il
      JOIN invoices AS i ON i.id = il.invoice_id AND i.org_id = il.org_id
      WHERE il.source_type = 'time_entry'
        AND il.source_id = te.id
        AND il.org_id = te.org_id
        AND i.status IN ('sent', 'partially_paid', 'overdue', 'paid')
    );

  GET DIAGNOSTICS repaired_count = ROW_COUNT;
  RAISE WARNING 'orphan billed-source repair: reset % time_entries row(s) without issued invoice lineage', repaired_count;
END $$;

DO $$
DECLARE
  repaired_count bigint;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  UPDATE ticket_parts AS tp
  SET billing_status = 'not_billed', updated_at = now()
  WHERE tp.billing_status = 'billed'
    AND NOT EXISTS (
      SELECT 1
      FROM invoice_lines AS il
      JOIN invoices AS i ON i.id = il.invoice_id AND i.org_id = il.org_id
      WHERE il.source_type = 'part'
        AND il.source_id = tp.id
        AND il.org_id = tp.org_id
        AND i.status IN ('sent', 'partially_paid', 'overdue', 'paid')
    );

  GET DIAGNOSTICS repaired_count = ROW_COUNT;
  RAISE WARNING 'orphan billed-source repair: reset % ticket_parts row(s) without issued invoice lineage', repaired_count;
END $$;
