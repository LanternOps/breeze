-- #4095: recovery path for webhook deliveries recorded but never enqueued.
--
-- `webhook_deliveries` rows are committed to Postgres BEFORE `queueDelivery`,
-- which is a bare `redis.lpush` onto a non-durable list. If that LPUSH throws,
-- or the process dies between the commit and the LPUSH, the row sits at
-- `status = 'pending'` with no job anywhere and nothing ever looks at it again.
-- Latent while delivery is at-most-once; once wave 3.5c (#4085) makes it
-- at-least-once, the redelivered event hits the (webhook_id, event_id) unique
-- index from 2026-09-11-a, the '*' subscriber skips, and that pair is
-- suppressed forever.
--
-- Two additions, both driving `jobs/webhookDeliveryRecovery.ts`.

-- 1. A dedicated recovery counter.
--
-- The sweep needs a bounded number of attempts per row, and it cannot borrow
-- `attempts`: that column is the HTTP attempt count the delivery callback
-- overwrites (`SET attempts = result.attempts`) and the UI renders as such.
-- Counting enqueue recoveries in it would both misreport the delivery history
-- and lose the count on the first completed callback.
ALTER TABLE webhook_deliveries
  ADD COLUMN IF NOT EXISTS recovery_attempts integer NOT NULL DEFAULT 0;

-- 2. A PARTIAL index over the candidate set.
--
-- The sweep runs every five minutes forever, and `webhook_deliveries` has no
-- retention job anywhere — it grows without bound. A plain index on
-- (status, created_at) would grow with the table; this one only ever holds
-- rows in a TRANSIENT state, so in a healthy fleet it stays at approximately
-- zero entries no matter how large the table gets, and the sweep is an index
-- scan over nothing rather than a sequential scan over everything.
--
-- `pending` and `retrying` are both indexed because both are unresolved:
-- `pending` = never claimed by a worker (safe to re-drive), `retrying` =
-- claimed but never completed (outcome unknown, resolved terminally rather
-- than re-POSTed). `delivered` and `failed` are terminal and excluded.
-- Keyed on created_at ALONE, not (status, created_at). The partial predicate
-- already restricts the index to the two unresolved statuses, so carrying
-- `status` as the leading key buys nothing and actively costs: with a 2-value
-- IN, a (status, created_at) index yields two separately-ordered runs, so the
-- sweep's `ORDER BY created_at` needs a sort (or a merge) on top. Keyed on
-- created_at the index IS the order, oldest-first, which is exactly how the
-- sweep drains its bounded batch. Same number of entries either way.
CREATE INDEX IF NOT EXISTS webhook_deliveries_unresolved_idx
  ON webhook_deliveries (created_at)
  WHERE status IN ('pending', 'retrying');
