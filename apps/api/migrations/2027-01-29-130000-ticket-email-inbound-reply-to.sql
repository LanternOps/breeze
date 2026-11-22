-- Email-first replies W1 (Refs #8758): the inbound message's Reply-To.
--
-- Set at ingest only when the header held exactly one valid address that is
-- not one of the partner's own mailboxes or inbound addresses (replyTo.ts,
-- replyToGuard.ts). The ticket notify worker answers the requester at the
-- reply_to_address of the ticket's creating row, else at from_address.
--
-- Nullable, no backfill: rows written before this column fall back to From,
-- which is today's behaviour. ticket_email_inbound is partner-axis (shape 3,
-- no org_id), so the column inherits the table's existing RLS policies and
-- needs no export-policy or org-cascade entry. No rows are written here.

ALTER TABLE ticket_email_inbound ADD COLUMN IF NOT EXISTS reply_to_address text;
