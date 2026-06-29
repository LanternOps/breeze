-- Persist the point-in-time data snapshot for a completed report run so it can be
-- downloaded later (CSV/Excel/PDF) without re-querying live data.
-- report_runs is RLS-covered via the FK-child backstop through reports; adding a
-- column does not change its tenancy shape.
ALTER TABLE report_runs ADD COLUMN IF NOT EXISTS result jsonb;
