-- @no-transaction
-- script_executions: (script_id, created_at DESC) for the Script Library's
-- "last run" column (#9563).
--
-- GET /scripts now projects, per listed script, the newest
-- script_executions.created_at the caller can see (a correlated max() per
-- page row). The existing script_executions_script_id_idx (script_id) makes
-- each max() read every execution of that script from the heap, and the table
-- has no retention: a script used as a monitor probe or automation step
-- accumulates hundreds of thousands of rows. With created_at in the index the
-- planner answers max() with a short backward index scan instead.
--
-- CREATE INDEX CONCURRENTLY (autoMigrate's @no-transaction lane) so the build
-- does not take a SHARE lock on this hot table at deploy time. No row writes.

CREATE INDEX CONCURRENTLY IF NOT EXISTS script_executions_script_created_at_idx
  ON script_executions (script_id, created_at DESC);
