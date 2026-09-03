-- @no-transaction
-- Device activity feed under RLS: partial indexes over the non-agent slice of
-- audit_logs (apps/api/src/routes/devices/events.ts).
--
-- Why the 2026-06-21 feed indexes never helped in production: the feed runs as
-- breeze_app with RLS forced, and under a security qual Postgres only promotes a
-- clause to an index condition when it is leakproof. The OR arm
-- `details->>'deviceId' = $device` calls jsonb_object_field_text (not leakproof),
-- which poisons the whole `(resource_id = X OR details->>... = X)` clause;
-- `action LIKE ...` (textlike) and `actor_type IN (...)` (enum_eq) are not
-- leakproof either. The only promotable clause left was `org_id = $org`, so every
-- device page load walked the org's entire audit history through
-- audit_logs_org_timestamp_idx: 2.4M rows / 4 GB for the largest US org, 90 s
-- mean, 13+ min worst case, two parallel workers saturating the 1-vCPU managed
-- DB and exhausting its connection slots (2026-09-03).
--
-- 99% of audit_logs rows are agent telemetry (actor_type 'agent':
-- agent.logs.submit, agent.sessions.submit, ...) and the feed never wants them:
-- the largest US org has ~300 non-agent rows per 30 days against 1.67M total.
--
-- The route now splits the feed into two arms with `actor_type <> 'agent'` as a
-- top-level predicate. Partial-index predicate proof is static, so the
-- non-leakproof enum_ne is fine there; the index *conditions* below are uuid_eq,
-- which is leakproof:
--
--   * (resource_id, timestamp DESC) WHERE actor_type <> 'agent'
--       deliberate-action feed (device overview): resource_id = device.
--   * (org_id, timestamp DESC) WHERE actor_type <> 'agent' AND details ? 'deviceId'
--       rows that reference the device only through details.deviceId
--       (device.command.queue, remote sessions): org_id = device's org, then
--       filter. The extra `details ? 'deviceId'` predicate matters: the org's
--       non-agent history alone was ~700 rows / 500 heap pages on US and cost
--       66 s under IO saturation; only a handful of those rows carry deviceId.
--
-- Both are a fraction of a percent of the table. CREATE INDEX CONCURRENTLY avoids the SHARE lock on
-- a table every route writes to; IF NOT EXISTS keeps re-application a no-op
-- (US prod had both created by hand on 2026-09-03, ahead of the release).

CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_logs_device_feed_resource_idx
  ON audit_logs (resource_id, "timestamp" DESC)
  WHERE actor_type <> 'agent';

CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_logs_device_feed_details_idx
  ON audit_logs (org_id, "timestamp" DESC)
  WHERE actor_type <> 'agent' AND details ? 'deviceId';
