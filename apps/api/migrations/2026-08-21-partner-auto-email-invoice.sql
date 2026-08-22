-- Auto-email the issued invoice when a quote is accepted (2026-08-21 spec §8).
-- Partner-level toggle, DEFAULT ON: acceptance already issues the invoice
-- (status 'sent'), and the customer losing the one-shot pay moment was a real
-- support case — the email with the durable public link is the recovery path.
-- A dedicated boolean column (not partners.settings JSONB) deliberately: the
-- settings cards replace sub-objects wholesale (#3597/#3606), and a column
-- makes the gate expression and the read-back trivially the same.
ALTER TABLE partners ADD COLUMN IF NOT EXISTS auto_email_invoice_on_quote_accept boolean NOT NULL DEFAULT true;
