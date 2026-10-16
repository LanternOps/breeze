-- AI Suggested Fixes follow-up (#7278): rotate the fix-memory sweeper's
-- rebuild retries by last attempt.
--
-- stalePartnerIds ordered candidates by their oldest stale_since only, so
-- partners that can never be un-staled (a pending erasure request for an org
-- whose erasure keeps failing, or a rebuild that throws every time) kept the
-- oldest timestamp forever and took every slot of every sweep. The sweeper now
-- stamps rebuild_attempted_at on a partner's candidate rows before each
-- rebuild attempt, in its own transaction, and orders by it (never attempted
-- first).
--
-- Schema only: no rows are written, so no system-scope election is needed.
-- Nullable with no default, so the ADD COLUMN is metadata-only.

ALTER TABLE fix_memory
  ADD COLUMN IF NOT EXISTS rebuild_attempted_at timestamptz;

COMMENT ON COLUMN fix_memory.rebuild_attempted_at IS
  'When the fix-outcome sweeper last attempted to rebuild this row''s partner. Orders stalePartnerIds so stuck partners cannot starve the retry pass (#7278).';
