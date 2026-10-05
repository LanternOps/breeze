-- Per-mailbox Gmail "mark handled" settings (#7949).
--
-- gmail_handled_label: the user label added to Gmail mail that became a ticket
--   or was threaded onto one. NULL = off (the default; the connector then only
--   reads). Only a Gmail row may carry it.
-- gmail_archive_on_handle: also remove INBOX from that mail.
-- gmail_handled_error / gmail_handled_error_at: the last marking failure for the
--   mailbox, as a fixed code the mailbox settings card shows. Cleared on the next
--   successful mark, on a settings change and on reconnect.
--
-- Schema only, no row writes. Idempotent: ADD COLUMN IF NOT EXISTS, and each
-- CHECK is dropped and re-added.

ALTER TABLE ticket_mailbox_connections
  ADD COLUMN IF NOT EXISTS gmail_handled_label text,
  ADD COLUMN IF NOT EXISTS gmail_archive_on_handle boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS gmail_handled_error varchar(32),
  ADD COLUMN IF NOT EXISTS gmail_handled_error_at timestamptz;

ALTER TABLE ticket_mailbox_connections
  DROP CONSTRAINT IF EXISTS ticket_mailbox_connections_gmail_handled_label_check;
ALTER TABLE ticket_mailbox_connections
  ADD CONSTRAINT ticket_mailbox_connections_gmail_handled_label_check
  CHECK (
    gmail_handled_label IS NULL
    OR (provider = 'gmail' AND char_length(gmail_handled_label) BETWEEN 1 AND 100)
  );

ALTER TABLE ticket_mailbox_connections
  DROP CONSTRAINT IF EXISTS ticket_mailbox_connections_gmail_handled_error_check;
ALTER TABLE ticket_mailbox_connections
  ADD CONSTRAINT ticket_mailbox_connections_gmail_handled_error_check
  CHECK (
    gmail_handled_error IS NULL
    OR gmail_handled_error IN ('access_denied', 'rate_limited', 'unavailable', 'label_invalid', 'no_credential', 'failed')
  );
