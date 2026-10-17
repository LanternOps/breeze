-- security_agents config-policy feature type (#6960, wave #8735).
--
-- Its own migration: a new enum value cannot be used in the transaction that
-- adds it, and autoMigrate wraps each file in a transaction. No rows are
-- written. Idempotent via IF NOT EXISTS. Appended last, matching the drizzle
-- enum list order (drizzle-kit compares value order).
ALTER TYPE config_feature_type ADD VALUE IF NOT EXISTS 'security_agents';
