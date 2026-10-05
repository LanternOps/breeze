-- Recognize Emsisoft, Webroot and WithSecure (F-Secure) as first-class antivirus
-- providers. Previously the agent reported them as 'other', so AV coverage and
-- the security posture reports could not name them (#7551). ThreatDown maps to
-- the existing 'malwarebytes' value and needs no new label.
-- Insert before 'other' to keep the catch-all value last in the enum order.
-- ADD VALUE IF NOT EXISTS makes each statement a no-op on re-apply.
ALTER TYPE security_provider ADD VALUE IF NOT EXISTS 'emsisoft' BEFORE 'other';
ALTER TYPE security_provider ADD VALUE IF NOT EXISTS 'webroot' BEFORE 'other';
ALTER TYPE security_provider ADD VALUE IF NOT EXISTS 'withsecure' BEFORE 'other';
