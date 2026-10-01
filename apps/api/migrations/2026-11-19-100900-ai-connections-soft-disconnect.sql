-- AI model registry W03 (#7601, PR #7700 review finding 1): a compat
-- connection is SOFT-disconnected, never deleted.
--
-- Deleting a partner_ai_connections row cascades to its partner_ai_models
-- offerings (FK ON DELETE CASCADE). A turn reserved and dispatched on one of
-- those offerings then cannot settle: ai_invocations_provenance_guard rejects
-- a ledger row whose offering no longer exists (23503), so the spend is lost.
-- Disconnect (and a BYOK <-> catalog kind switch, which disconnects first)
-- now keeps the row as provenance with status 'disconnected', its key
-- material NULLed (revocation still removes the secret), and its offerings
-- disabled.
--
--   * status_chk gains 'disconnected'.
--   * shape_chk: an Anthropic-dialect connection carries a key unless it is
--     disconnected.
--   * disconnected_keyless_chk: a disconnected connection carries NO key
--     material (with key_triplet_chk: all three key columns NULL).
--   * compat_uq ignores disconnected rows, so a later reconnect or kind switch
--     creates a NEW connection next to the disconnected one. An index
--     predicate cannot be altered: drop + re-create (the table is small; no
--     CONCURRENTLY inside autoMigrate's transaction).
--
-- No row writes (no system-scope election needed). Idempotent: DROP … IF
-- EXISTS then re-add. No BEGIN/COMMIT — autoMigrate wraps the file.

ALTER TABLE public.partner_ai_connections DROP CONSTRAINT IF EXISTS partner_ai_connections_status_chk;
ALTER TABLE public.partner_ai_connections ADD CONSTRAINT partner_ai_connections_status_chk
  CHECK (status IN ('active', 'error', 'disconnected'));

ALTER TABLE public.partner_ai_connections DROP CONSTRAINT IF EXISTS partner_ai_connections_shape_chk;
ALTER TABLE public.partner_ai_connections ADD CONSTRAINT partner_ai_connections_shape_chk CHECK (
  -- catalog ⇔ a catalog entry
  (kind = 'catalog') = (catalog_entry_id IS NOT NULL)
  -- openai_compatible ⇔ a base URL (W06); Anthropic-dialect kinds never carry one
  AND (kind = 'openai_compatible') = (base_url IS NOT NULL)
  -- the Anthropic-dialect kinds carry a key unless disconnected
  AND (kind NOT IN ('anthropic_byok', 'catalog') OR status = 'disconnected' OR api_key_encrypted IS NOT NULL)
);

ALTER TABLE public.partner_ai_connections DROP CONSTRAINT IF EXISTS partner_ai_connections_disconnected_keyless_chk;
ALTER TABLE public.partner_ai_connections ADD CONSTRAINT partner_ai_connections_disconnected_keyless_chk
  CHECK (status <> 'disconnected' OR api_key_encrypted IS NULL);

DROP INDEX IF EXISTS public.partner_ai_connections_compat_uq;
CREATE UNIQUE INDEX IF NOT EXISTS partner_ai_connections_compat_uq
  ON public.partner_ai_connections (partner_id)
  WHERE kind IN ('anthropic_byok', 'catalog') AND status <> 'disconnected';
