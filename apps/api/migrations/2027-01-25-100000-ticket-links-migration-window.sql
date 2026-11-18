-- Ticket links written in import mode (#8313 W2; spec
-- docs/superpowers/specs/api-platform/2026-10-19-ticket-import-modules-design.md
-- §5.3 item 4). An imported link is an ordinary ticket_links row; this column
-- says which migration window wrote it, like tickets.migration_window_id and
-- ticket_comments.migration_window_id. FK-less on purpose: a snapshot that
-- must outlive window retention and never couple an org table to a partner
-- table, so the org cascade, the org merge and FK deferrability are unchanged.
-- Nullable, so live rows are untouched and the ALTER is metadata-only.

ALTER TABLE ticket_links ADD COLUMN IF NOT EXISTS migration_window_id uuid;
