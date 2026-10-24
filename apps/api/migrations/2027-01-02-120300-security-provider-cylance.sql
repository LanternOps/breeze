-- Recognize CylancePROTECT (rebranded Aurora Endpoint Defense) as a first-class
-- antivirus provider. Previously the agent reported it as 'other', so AV
-- coverage and the security posture reports could not name it (#9178).
-- Insert before 'other' to keep the catch-all value last among product values,
-- matching the emsisoft/webroot/withsecure migration.
-- ADD VALUE IF NOT EXISTS makes the statement a no-op on re-apply. No row writes.
ALTER TYPE security_provider ADD VALUE IF NOT EXISTS 'cylance' BEFORE 'other';
