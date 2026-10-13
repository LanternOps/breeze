-- #8308: record consecutive transient Microsoft 365 poll failures on the
-- mailbox connection, so a mailbox that keeps failing with 5xx/429/network
-- errors no longer reads as healthy. Only a counter and a timestamp are
-- stored; the raw Graph error text stays in server logs (#6192).
--
-- ADD COLUMN with a constant default is catalog-only on PostgreSQL 11+, so no
-- table rewrite. No row writes, so no breeze.scope elevation is needed.
ALTER TABLE ticket_mailbox_connections
  ADD COLUMN IF NOT EXISTS consecutive_transient_failures integer NOT NULL DEFAULT 0;

ALTER TABLE ticket_mailbox_connections
  ADD COLUMN IF NOT EXISTS last_transient_failure_at timestamptz;

COMMENT ON COLUMN ticket_mailbox_connections.consecutive_transient_failures IS
  'Microsoft 365 poll sweeps in a row that failed transiently. Reset by a successful poll or a reconnect.';
COMMENT ON COLUMN ticket_mailbox_connections.last_transient_failure_at IS
  'When the most recent transient Microsoft 365 poll failure happened.';
