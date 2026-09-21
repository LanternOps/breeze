-- #6467: the invoice line's "X h worked, Y h billed" disclosure was baked as
-- hardcoded English prose into invoice_lines.description (a user-editable
-- field), so any later description edit silently erased the §3.5-required
-- note and no non-English org ever saw it in their own language.
--
-- Fix: carry the worked quantity as structured data on the line itself so the
-- disclosure survives a description edit and can be rendered in the viewer's
-- locale at display time (web/portal/PDF), instead of living in prose.
--
-- NULL = not a time-entry line (manual/catalog/bundle/part lines never carry
-- a "worked" figure) OR a legacy row materialized before this column existed.
-- Renderers show the note only when worked_minutes IS NOT NULL and differs
-- from the billed quantity — exactly mirroring the old description-suffix
-- condition, just computed from a column that a description edit cannot touch.
--
-- Idempotent. No inner BEGIN/COMMIT. DDL only — no row is written, so no
-- cleanup-statement row-count logging applies.

ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS worked_minutes integer;

COMMENT ON COLUMN invoice_lines.worked_minutes IS
  'Actual time worked (time_entries.duration_minutes) for a time_entry-sourced line, for the worked-vs-billed disclosure note only — never for money. NULL for non-time-entry lines and for legacy rows predating this column (#6467).';
