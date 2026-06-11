-- Task 19 (launch-readiness): Track last source IP per device for the agent
-- auth gate. We compare the current trusted client IP against this column on
-- every authenticated agent request; a change emits an
-- `agent.source.ip.changed` audit (deduped via Redis at one event / IP /
-- device / 24h) and the column is updated fire-and-forget.
--
-- 45 chars is enough for IPv6 addresses (including IPv4-mapped forms).
--
-- Idempotent: safe to re-run.

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS last_seen_ip varchar(45);
