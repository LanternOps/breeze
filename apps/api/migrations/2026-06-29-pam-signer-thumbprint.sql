-- PAM signer-group / rule certificate thumbprint pinning (#1776).
--
-- Subject-CN-only signer matching is spoofable (anyone can mint a cert bearing
-- a trusted CN), and with the trusted-publisher catalog (#1771) a matched
-- signer can auto-approve privilege elevation. This adds a STRONG tier: pin the
-- SHA-256 Authenticode leaf-cert thumbprint, which is bound to a specific key
-- and not forgeable. CN matching stays as the clearly-labeled WEAK/legacy tier.
--
-- Additive + backward-compatible:
--   * pam_rules gains a nullable match_signer_thumbprint (parallel to
--     match_signer); existing rows are untouched.
--   * pam_signer_groups.signers keeps its jsonb column — its element shape
--     evolves in app code from `string[]` (bare CNs) to entry objects that may
--     carry a thumbprint. A read normalizer (normalizeSignerGroupEntries) maps
--     legacy bare strings to {subjectCn}, so existing rows need NO data
--     migration and keep matching on CN exactly as before. No SQL change is
--     required for that column.
--
-- Tenancy: both tables are RLS Shape 1 (direct org_id), already enabled +
-- forced. Adding a column does not change the tenancy shape and needs no new
-- policy — the existing breeze_has_org_access(org_id) policies cover the new
-- column. No rls-coverage allowlist change.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS. Re-applying is a no-op. autoMigrate
-- wraps each file in a transaction; no inner BEGIN/COMMIT.

ALTER TABLE pam_rules
  ADD COLUMN IF NOT EXISTS match_signer_thumbprint varchar(64);
