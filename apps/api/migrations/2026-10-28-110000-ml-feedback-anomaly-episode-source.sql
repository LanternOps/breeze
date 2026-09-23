-- Allow ml_feedback_events to carry an episode-level label row, distinct from the
-- existing per-bucket 'anomaly' source type. See W03 of
-- docs/superpowers/plans/monitoring/2026-09-21-metric-anomaly-episodes.md.
-- No row writes in this file, so no set_config('breeze.scope', 'system')
-- elevation is needed (CLAUDE.md "Any migration that writes rows must elect
-- system scope FIRST" applies only to UPDATE/DELETE/INSERT/MERGE, none of
-- which occur here).

ALTER TABLE ml_feedback_events
  DROP CONSTRAINT IF EXISTS ml_feedback_events_source_type_check;

ALTER TABLE ml_feedback_events
  ADD CONSTRAINT ml_feedback_events_source_type_check
  CHECK (source_type IN (
    'alert', 'ticket', 'device', 'anomaly', 'anomaly_episode', 'correlation', 'rca',
    'remediation', 'user_risk'
  ));
