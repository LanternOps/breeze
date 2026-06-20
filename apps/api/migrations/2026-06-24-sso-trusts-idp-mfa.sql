-- Security review #2 (H-1): per-provider opt-in for trusting IdP-asserted MFA.
-- When trusts_idp_mfa is true AND the verified OIDC id_token's `amr` attests
-- multi-factor (RFC 8176 `mfa`), the SSO callback mints mfa:true so the org can
-- satisfy Breeze's MFA-gated routes via their IdP. Off by default (fail-safe);
-- providers that don't opt in always yield mfa:false. The claim never satisfies
-- the L4 step-up, which independently re-verifies a Breeze-held factor.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS. No tenant axis (sso_providers is
-- org-scoped and already RLS-covered).
ALTER TABLE sso_providers
  ADD COLUMN IF NOT EXISTS trusts_idp_mfa boolean NOT NULL DEFAULT false;
