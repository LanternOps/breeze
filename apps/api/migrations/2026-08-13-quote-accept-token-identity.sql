-- Quote re-send + stable share link.
--
-- Persist the IDENTITY of the accept token minted at send time — its jti, iat,
-- exp and signing kid — so the exact same token can be reproduced on demand
-- (services/quoteAcceptToken.ts regenerateQuoteAcceptToken). A quote therefore
-- keeps ONE stable customer-facing link across re-sends and "copy share link".
--
-- None of these columns is a bearer credential: the token string is only
-- derivable with the JWT signing key, so DB read access alone yields nothing
-- usable. That is the whole point of storing the parts instead of the token.
--
-- NULL on drafts, and on every quote sent before this migration — those have no
-- recoverable link and mint a fresh token the first time one is requested.

ALTER TABLE quotes ADD COLUMN IF NOT EXISTS accept_token_jti VARCHAR(128);
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS accept_token_issued_at TIMESTAMPTZ;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS accept_token_expires_at TIMESTAMPTZ;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS accept_token_kid VARCHAR(128);
