-- #10862: a Microsoft 365 mailbox can name the inline mail gateways it trusts to
-- report sender authentication, by ARC sealing domain (the d= of an ARC-Seal).
-- Empty by default, so nothing changes for a mailbox that does not set it.
--
-- A CHECK caps the list at 10 and keeps it empty on non-m365 rows. No row is
-- written here: the default fills existing rows.

ALTER TABLE ticket_mailbox_connections
  ADD COLUMN IF NOT EXISTS trusted_arc_sealers text[] NOT NULL DEFAULT '{}';

ALTER TABLE ticket_mailbox_connections
  DROP CONSTRAINT IF EXISTS ticket_mailbox_connections_trusted_arc_sealers_check;

ALTER TABLE ticket_mailbox_connections
  ADD CONSTRAINT ticket_mailbox_connections_trusted_arc_sealers_check
  CHECK (
    cardinality(trusted_arc_sealers) <= 10
    AND (provider = 'm365' OR cardinality(trusted_arc_sealers) = 0)
  );
