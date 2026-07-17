-- Per-partner email signature, appended to outbound customer emails (quote
-- sends today; other partner-authored mail later). Plain text; rendered
-- escaped. Partner-owned setting — no new RLS needed (partners is id-keyed
-- with existing partner-access policies).
ALTER TABLE partners ADD COLUMN IF NOT EXISTS email_signature text;
