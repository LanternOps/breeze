-- #8603 (feature #8601, refs #8078): the date a time-entry invoice line was
-- worked, in the partner's timezone, captured at assembly and copied on reissue.
-- NULL on every pre-existing line (no backfill: issued invoices are immutable)
-- and on every non-time_entry line (parts, AI usage, block-hours overage).
-- Nullable, no default: a metadata-only add on a hot table. No index: nothing
-- filters on it. No row writes, so no breeze.scope election is needed.
ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS work_date date;
