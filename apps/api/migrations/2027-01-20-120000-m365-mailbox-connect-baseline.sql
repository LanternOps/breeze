-- #10863: connecting a Microsoft 365 mailbox must not import what is already in it.
-- The connect instant becomes a floor on the Graph path too, so eligible_after is
-- no longer Gmail-only. The two new columns record the first delta round that
-- walked past the backlog, for the note on the mailbox card.
--
-- No row is written here: an m365 row that already has a delta cursor keeps a NULL
-- floor and polls exactly as before.

ALTER TABLE ticket_mailbox_connections
  ADD COLUMN IF NOT EXISTS baseline_skipped_count integer NOT NULL DEFAULT 0;

ALTER TABLE ticket_mailbox_connections
  ADD COLUMN IF NOT EXISTS baseline_completed_at timestamptz;

-- Same name as before. The m365 branch may now carry eligible_after; the gmail
-- branch now also refuses the Microsoft-only baseline columns. Drop-and-recreate
-- for idempotency.
ALTER TABLE ticket_mailbox_connections
  DROP CONSTRAINT IF EXISTS ticket_mailbox_connections_provider_fields_consistent;

ALTER TABLE ticket_mailbox_connections
  ADD CONSTRAINT ticket_mailbox_connections_provider_fields_consistent
  CHECK (
    (provider = 'm365'
       AND org_id IS NULL AND google_account_sub IS NULL
       AND history_id IS NULL)
    OR
    (provider = 'gmail' AND tenant_id IS NULL
       AND baseline_skipped_count = 0 AND baseline_completed_at IS NULL)
  );

ALTER TABLE ticket_mailbox_connections
  DROP CONSTRAINT IF EXISTS ticket_mailbox_connections_baseline_skipped_count_check;

ALTER TABLE ticket_mailbox_connections
  ADD CONSTRAINT ticket_mailbox_connections_baseline_skipped_count_check
  CHECK (baseline_skipped_count >= 0);
