SELECT set_config('breeze.scope', 'system', true);
-- WRITES ROWS: system scope precedes every write under FORCE RLS.
-- The override permission binds existing roles on release day (§10 decision 2).
-- No grant back-fill: wildcard holders already match; others are granted by an operator.
-- permissions has no UNIQUE(resource, action); mirror the W01 permission seed.
DO $$
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'time_entries' AND action = 'manage_billing') THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('time_entries', 'manage_billing', 'Override and reset time entry billing terms');
    RAISE WARNING 'seeded time_entries:manage_billing permission row';
  END IF;
END $$;
