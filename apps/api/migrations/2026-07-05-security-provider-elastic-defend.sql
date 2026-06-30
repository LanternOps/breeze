-- Recognize Elastic Defend as a first-class antivirus provider.
-- Previously WSC-reported Elastic agents normalized to 'other', so AV-coverage
-- detection treated Elastic Defend-protected devices as unprotected (#2018).
-- Insert before 'other' to keep the catch-all value last in the enum order.
ALTER TYPE security_provider ADD VALUE IF NOT EXISTS 'elastic_defend' BEFORE 'other';
