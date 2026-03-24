-- Make alerts.rule_id nullable to support system-generated alerts (e.g. warranty expiry)
-- that are not tied to a user-created alert rule.
-- The Drizzle schema already defines rule_id as nullable; this aligns the DB.
ALTER TABLE alerts ALTER COLUMN rule_id DROP NOT NULL;
