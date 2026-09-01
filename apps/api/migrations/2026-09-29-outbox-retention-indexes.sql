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
-- Plain (non-partial) btree: Postgres indexes NULLs, but `published_at <
-- cutoff` never matches a NULL row regardless, so a plain index range-scans
-- the non-null values exactly like a partial `WHERE published_at IS NOT
-- NULL` index would — without the DDL support for the trailing NOT NULL
-- variant that a few sibling tables already use elsewhere in this file set
-- (see e.g. the *_unpublished_idx precedent this migration mirrors).
CREATE INDEX IF NOT EXISTS ticket_outbox_published_at_idx
  ON ticket_outbox (published_at);

CREATE INDEX IF NOT EXISTS intent_outbox_published_at_idx
  ON intent_outbox (published_at);

CREATE INDEX IF NOT EXISTS metric_anomaly_incidents_dispatched_at_idx
  ON metric_anomaly_incidents (dispatched_at);
