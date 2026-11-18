-- @no-transaction
-- dns_security_events: partial index for the blocked-only Events tab, and drop
-- the duplicate (integration_id, provider_event_id) index (#10054).
--
-- The DNS Security Events tab lists blocked events newest first. The only
-- org-scoped index was dns_security_events_org_ts_idx (org_id, timestamp DESC),
-- so `action = 'blocked'` was a filter over every row of the org: blocked is
-- under 1% of a stored DNS log, and a self-hosted 30M-row table took 131 s to
-- answer (the reverse proxy returned 504). GET /dns-security/events now pages
-- on (timestamp, id) with a keyset cursor inside a default 7-day window
-- (apps/api/src/services/dnsSecurityEventsPage.ts); this index answers the
-- blocked-only page with a short backward index scan.
--
-- Index conditions under forced RLS: org_id = $1 (uuid_eq) and the
-- (timestamp, id) < ($2, $3) row comparison (timestamp_lt, uuid_lt) are
-- leakproof, so the planner may use them as index conditions. The
-- `action = 'blocked'` predicate is matched statically against the partial
-- index predicate, so the non-leakproof enum comparison does not matter.
--
-- dns_security_events_provider_id_idx duplicated the unique index
-- dns_security_events_provider_evt_uniq column for column; the unique index
-- serves every lookup and the ON CONFLICT upsert, so the copy only cost write
-- amplification and disk.
--
-- CONCURRENTLY (autoMigrate's @no-transaction lane): the DNS sync inserts into
-- this table every 15 minutes per integration, and a plain CREATE INDEX would
-- hold a SHARE lock for the whole build on a multi-million-row table. If a
-- concurrent build fails it leaves an INVALID index that IF NOT EXISTS then
-- skips; an operator drops it (DROP INDEX CONCURRENTLY
-- dns_security_events_org_blocked_ts_idx) and the next boot rebuilds it.
-- No row writes.

CREATE INDEX CONCURRENTLY IF NOT EXISTS dns_security_events_org_blocked_ts_idx
  ON dns_security_events (org_id, timestamp, id)
  WHERE action = 'blocked';

DROP INDEX CONCURRENTLY IF EXISTS dns_security_events_provider_id_idx;
