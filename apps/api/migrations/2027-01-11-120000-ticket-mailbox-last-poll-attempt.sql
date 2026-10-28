-- #8308: when the Microsoft 365 poll sweep last started work on a mailbox,
-- whether or not Graph answered. The sweep takes mailboxes oldest attempt first
-- (nulls first), so a mailbox the pass deadline did not reach goes ahead of every
-- mailbox it did reach on the next sweep. last_polled_at cannot do this: it only
-- moves when a delta round completes, so a mailbox that keeps failing would keep
-- its old value and stay ahead of the others.
--
-- ADD COLUMN with no default is catalog-only, so no table rewrite. No row
-- writes, so no breeze.scope elevation is needed.
ALTER TABLE ticket_mailbox_connections
  ADD COLUMN IF NOT EXISTS last_poll_attempt_at timestamptz;

COMMENT ON COLUMN ticket_mailbox_connections.last_poll_attempt_at IS
  'When the Microsoft 365 poll sweep last started work on this mailbox. Orders the sweep, oldest first.';
