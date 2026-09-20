-- W02 removes all API writes to legacy pricing columns. Keep the NOT NULL/FK
-- contract until W04, while allowing new SLA-only org_ticket_settings rows.
-- This inert value is never read for pricing; existing snapshots are untouched.
ALTER TABLE org_ticket_settings ALTER COLUMN rate_currency SET DEFAULT 'USD';
