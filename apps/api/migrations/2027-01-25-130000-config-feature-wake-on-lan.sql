-- wake_on_lan config-policy feature type (Wake-on-LAN management, #10838).
--
-- Its own migration: a new enum value cannot be used in the transaction that
-- adds it, and autoMigrate wraps each file in a transaction. No rows are
-- written. Idempotent via IF NOT EXISTS. Appended last, matching the drizzle
-- enum list order (drizzle-kit compares value order).
ALTER TYPE config_feature_type ADD VALUE IF NOT EXISTS 'wake_on_lan';
