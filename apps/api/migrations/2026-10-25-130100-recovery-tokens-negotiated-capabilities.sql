-- W09 (#6464) Task 2 — records which recovery-download capabilities the
-- server GRANTED a token at authenticate/exchange time (Part 0 §1). NULL for
-- every token minted before this wave and for any token that never
-- negotiated (self-contained snapshot, R1). No CHECK on array contents: the
-- only capability string that exists today is the membership one
-- (BACKUP_SNAPSHOT_FILE_MEMBERSHIP_CAPABILITY, backupObjectKey.ts), and this
-- column is forward-compatible with future capability strings by design
-- (Part 0 §1 "Unknown capability strings are ignored").
--
-- Idempotent. No inner BEGIN/COMMIT. DDL only — no row is written, so no
-- breeze.scope election is required. No per-table GRANT (ensureAppRole.ts).

ALTER TABLE recovery_tokens
  ADD COLUMN IF NOT EXISTS negotiated_capabilities text[];

COMMENT ON COLUMN recovery_tokens.negotiated_capabilities IS
  'W09 (#6464): capabilities the SERVER granted this token at authenticate/exchange (subset of what the client sent). NULL = legacy token or a negotiation that granted nothing (self-contained snapshot).';
