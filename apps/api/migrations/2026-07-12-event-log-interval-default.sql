-- Issue #2390: event-log collection interval default 5m -> 15m.
-- The column default is shadowed in practice (the API always writes an explicit
-- value parsed through eventLogInlineSettingsSchema, which now defaults to 15),
-- but the DB default is part of the documented sync-set (agent NewEventLogCollector,
-- shared eventLogInlineSettingsSchema, API EVENT_LOG_DEFAULTS, web EventLogTab) —
-- a future raw insert or backfill omitting the column must not silently
-- resurrect the 5-minute subprocess churn this change removes.
-- Existing rows are untouched: they were all written with explicit values.
ALTER TABLE config_policy_event_log_settings
  ALTER COLUMN collection_interval_minutes SET DEFAULT 15;
