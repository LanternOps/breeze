-- @no-transaction
-- #4210 — supporting indexes for the new ticket_outbox / intent_outbox /
-- metric_anomaly_incidents retention jobs.
--
-- Every sibling retention job's cutoff column already has a dedicated index
-- (agent_logs_timestamp_idx, reliability_history_*_collected_idx, etc). These
-- three outbox/incident tables did not: each only had a partial index on the
-- UNpublished/UNdispatched half (ticket_outbox_unpublished_idx,
-- intent_outbox_unpublished_idx, metric_anomaly_incidents_undispatched_idx),
-- which the publisher workers' own claim queries use — nothing indexed the
-- published/dispatched half that the retention job's cutoff scan
-- (`published_at`/`dispatched_at < now() - N days`, jobs/*Retention.ts) reads.
--
-- Plain (non-partial) btree, not a `WHERE published_at IS NOT NULL` partial
-- index like the *_unpublished_idx siblings above: Postgres indexes NULLs,
-- but `published_at < cutoff` never matches a NULL row regardless, so a
-- plain index range-scans the non-null values exactly as a partial index
-- would — a partial index would only save a little disk, not change what
-- the planner can do here.
--
-- CONCURRENTLY + `@no-transaction` (autoMigrate's no-tx lane), same as
-- 2026-05-17-g-agent-logs-composite-index.sql: all three tables are hot
-- write paths (ticket_outbox on every ticket lifecycle event,
-- intent_outbox on every action-intent transition, metric_anomaly_incidents
-- on every detector upsert) whose own publisher workers also poll them every
-- 5s, so a plain CREATE INDEX's SHARE lock for the build duration would
-- block those writers/pollers at deploy time. IF NOT EXISTS keeps it safe to
-- re-apply — a failed CONCURRENTLY build leaves an INVALID index that a
-- retry must DROP first (see autoMigrate.ts's no-transaction contract
-- comment), not silently re-attempt forever.
CREATE INDEX CONCURRENTLY IF NOT EXISTS ticket_outbox_published_at_idx
  ON ticket_outbox (published_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS intent_outbox_published_at_idx
  ON intent_outbox (published_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS metric_anomaly_incidents_dispatched_at_idx
  ON metric_anomaly_incidents (dispatched_at);
