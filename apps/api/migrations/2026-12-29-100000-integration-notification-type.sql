-- Its own migration: a new enum value cannot be used in the transaction that
-- adds it, and autoMigrate wraps each file in a transaction.
SELECT set_config('breeze.scope', 'system', true);
ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'integration';
