-- Feature #3: severity-by-exit-code for scripts-as-monitors.
-- Adds an opt-in mapping from script exit code to alert severity.
-- When NULL (default), existing behavior is unchanged.
-- When set, shape is: { "0": null, "1": "low", "2": "medium", "3": "high", "4": "critical" }
-- where a null severity for a code means "no alert" and any AlertSeverity string
-- triggers an alert at that severity.
ALTER TABLE scripts
  ADD COLUMN IF NOT EXISTS exit_code_severity_mapping jsonb;
