-- The server creation event precedes agent observations and needs a distinct
-- phase; using "received" here would falsely claim endpoint acknowledgement.
ALTER TABLE agent_rollback_events
  DROP CONSTRAINT IF EXISTS agent_rollback_events_phase_check;
ALTER TABLE agent_rollback_events
  DROP CONSTRAINT IF EXISTS agent_rollback_events_phase_chk;
ALTER TABLE agent_rollback_events
  ADD CONSTRAINT agent_rollback_events_phase_chk CHECK (
    phase IN ('requested', 'received', 'downloaded', 'verified', 'staged', 'swapped', 'restart_requested', 'healthy', 'failed', 'recovered')
  );
