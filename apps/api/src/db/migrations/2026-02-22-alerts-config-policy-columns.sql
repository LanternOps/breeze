-- Add config_policy_id and config_item_name columns to alerts table.
-- These were added to the Drizzle schema via db:push but never had a migration.

ALTER TABLE alerts
  ADD COLUMN IF NOT EXISTS config_policy_id uuid,
  ADD COLUMN IF NOT EXISTS config_item_name varchar(200);
