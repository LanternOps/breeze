-- #8604 (feature #8601 W03, refs #8078): invoice labor line itemization.
--
-- Partner default (one home: Billing settings → Documents) plus a per-invoice
-- override, frozen at issue — the #3205 device-appendix pattern. Four typed
-- scalars, not jsonb, so they stay CHECK-able and exportable as ordinary data:
--   grouping        'entry' (one row per time entry, today) | 'day' (rows under
--                   per-day sub-headers; render-time only, lines never merge)
--   show_date       print the day each time-entry line was worked (#8603 work_date)
--   show_note       print the technician's note (time_entries.description)
--   show_worked_time print "x h worked · y h billed" when the two differ (#6467)
-- Partner defaults reproduce today's document exactly (entry, no date, note
-- and worked time shown), so a partner who never opens the setting sees no change.
--
-- invoices.line_*: NULL on a draft = inherit the partner default. Both issue
-- writers (issueInvoice, quote-accept direct issue) stamp the RESOLVED values;
-- renderers read only the frozen columns for anything issued. Invoices issued
-- before this migration keep NULL and render with the defaults — the document
-- they were issued as — never with a partner's later choice. No backfill.
--
-- partners is small: a constant NOT NULL DEFAULT is metadata-only on PG >= 11.
-- invoices columns are nullable, no default. No row writes, so no breeze.scope
-- election. Idempotent.

ALTER TABLE partners ADD COLUMN IF NOT EXISTS invoice_line_grouping varchar(8) NOT NULL DEFAULT 'entry';
ALTER TABLE partners ADD COLUMN IF NOT EXISTS invoice_line_show_date boolean NOT NULL DEFAULT false;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS invoice_line_show_note boolean NOT NULL DEFAULT true;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS invoice_line_show_worked_time boolean NOT NULL DEFAULT true;

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS line_grouping varchar(8);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS line_show_date boolean;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS line_show_note boolean;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS line_show_worked_time boolean;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'partners_invoice_line_grouping_chk') THEN
    ALTER TABLE partners ADD CONSTRAINT partners_invoice_line_grouping_chk
      CHECK (invoice_line_grouping IN ('entry', 'day'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_line_grouping_chk') THEN
    ALTER TABLE invoices ADD CONSTRAINT invoices_line_grouping_chk
      CHECK (line_grouping IS NULL OR line_grouping IN ('entry', 'day'));
  END IF;
END $$;
