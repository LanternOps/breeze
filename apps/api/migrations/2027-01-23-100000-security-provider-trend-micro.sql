-- Recognize Trend Micro (Apex One, Worry-Free, Vision One endpoint agents) as a
-- first-class antivirus provider. Previously the agent reported it as 'other',
-- so AV coverage and the security posture reports could not name it (#8171).
-- Insert before 'other' to keep the catch-all value last among product values,
-- matching the cylance migration.
-- ADD VALUE IF NOT EXISTS makes the statement a no-op on re-apply. No row writes.
ALTER TYPE security_provider ADD VALUE IF NOT EXISTS 'trend_micro' BEFORE 'other';
