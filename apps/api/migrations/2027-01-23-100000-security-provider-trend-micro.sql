-- Recognize Trend Micro (Apex One, Worry-Free, Vision One endpoint agents) as a
-- first-class antivirus provider. Without this value the provider falls into
-- 'other', so AV coverage and the security posture reports cannot name it (#8171).
-- Insert before 'other' so the catch-all stays last among product values.
-- ADD VALUE IF NOT EXISTS makes the statement a no-op on re-apply. No row writes.
ALTER TYPE security_provider ADD VALUE IF NOT EXISTS 'trend_micro' BEFORE 'other';
