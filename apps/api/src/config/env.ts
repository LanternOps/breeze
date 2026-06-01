function envFlag(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export const MCP_OAUTH_ENABLED = envFlag('MCP_OAUTH_ENABLED');

// Google Workspace identity tools. Defaults OFF everywhere; an org must also
// have an explicit google_workspace_connections row before any tool is usable.
// Gates tool registration (aiAgentSdkTools.ts) and the connect routes.
export const GOOGLE_WORKSPACE_ENABLED = envFlag('GOOGLE_WORKSPACE_ENABLED', false);

// Microsoft 365 identity tools. Defaults OFF everywhere; an org must also have
// an explicit m365_connections row before any tool is usable. Gates tool
// registration (aiAgentSdkTools.ts) and the connect routes.
export const M365_ENABLED = envFlag('M365_ENABLED', false);

// Read at call time so tests can flip `IS_HOSTED` per-test without `vi.resetModules()`.
export function isHosted(): boolean {
  return envFlag('IS_HOSTED');
}

// Public URL of the breeze-billing payment-setup landing page. Empty on
// self-host. Consumed by the OAuth consent redirect (see Phase 2 Task 2.1
// of docs/superpowers/plans/2026-04-29-mcp-bootstrap-cleanup.md) — the
// consent handler redirects users to BILLING_URL?uid=<UID> when their
// partner.status != 'active'. Distinct from BREEZE_BILLING_URL, which is
// the internal service-to-service base URL used by breezeBillingClient.ts.
export const BILLING_URL = process.env.BILLING_URL ?? '';

// DCR (Dynamic Client Registration) defaults OFF in all environments.
// Production deployments must explicitly opt in by setting OAUTH_DCR_ENABLED=true,
// AND must also set OAUTH_DCR_REQUIRE_IAT=true (boot-refused otherwise — see
// config/validate.ts). The IAT (initial-access-token) requirement closes the
// public-spam vector: without it, anyone on the internet can POST /oauth/reg
// and create clients with deceptive client_name strings.
export const OAUTH_DCR_ENABLED = envFlag('OAUTH_DCR_ENABLED', false);
export const OAUTH_DCR_REQUIRE_IAT = envFlag('OAUTH_DCR_REQUIRE_IAT', false);
export const OAUTH_ISSUER = process.env.OAUTH_ISSUER ?? '';
export const OAUTH_RESOURCE_URL = process.env.OAUTH_RESOURCE_URL ?? '';
// Optional override for the consent UI base. Defaults to '' (relative path)
// — in prod the API and web share the same origin behind Caddy, so a
// relative redirect works. In local dev where API and web run on different
// ports, set this to e.g. http://localhost:4321 so the browser navigates
// to the web origin instead of the API origin.
export const OAUTH_CONSENT_URL_BASE = process.env.OAUTH_CONSENT_URL_BASE ?? '';
export const OAUTH_JWKS_PRIVATE_JWK = process.env.OAUTH_JWKS_PRIVATE_JWK ?? '';
export const OAUTH_JWKS_PUBLIC_JWK = process.env.OAUTH_JWKS_PUBLIC_JWK ?? '';
export const OAUTH_COOKIE_SECRET = process.env.OAUTH_COOKIE_SECRET ?? '';

// Kill-switch for the role-level MFA gate (Task 8 of the launch-readiness
// sprint). Defaults ON so the secure-by-default posture holds; ops can
// flip it OFF without a code change to relieve an enrollment outage that
// locks legitimate partner-admins out. Read at call time so tests and
// runtime overrides don't need module re-evaluation.
export function mfaForcePartnerAdmin(): boolean {
  return envFlag('MFA_FORCE_FOR_PARTNER_ADMIN', true);
}

// Delegant service configuration for M365 helpdesk agent capability.
// Delegant is a sibling service that manages AI-agent identity and governance.
export const DELEGANT_BASE_URL = process.env.DELEGANT_BASE_URL ?? '';
export const DELEGANT_SERVICE_TOKEN = process.env.DELEGANT_SERVICE_TOKEN ?? '';
export const DELEGANT_PRINCIPAL_SIGNING_KEY = process.env.DELEGANT_PRINCIPAL_SIGNING_KEY ?? '';
export const DELEGANT_PRINCIPAL_KID = process.env.DELEGANT_PRINCIPAL_KID ?? '';
