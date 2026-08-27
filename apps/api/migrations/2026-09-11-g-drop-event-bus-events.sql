-- Drop event_bus_events: never wired to any reader or writer.
--
-- This table was schema scaffolding for the never-built EventBus
-- consumer-group / dead-letter-queue machinery (see the same-PR deletion of
-- `startConsuming`/`consumeLoop`/`processMessage`/`retryDeadLetter` etc. from
-- `apps/api/src/services/eventBus.ts`, wave 3.5c, #4085). Verified
-- zero `INSERT`/`SELECT` against this table repo-wide as of 2026-08-26 —
-- actual event delivery has always gone through Redis Streams (XADD) and
-- pub/sub, never through this Postgres table.
DROP TABLE IF EXISTS event_bus_events;

-- event_bus_priority backed only the dropped table's `priority` column; drop it too.
DROP TYPE IF EXISTS event_bus_priority;
