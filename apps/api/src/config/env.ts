export function envFlag(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export const MCP_OAUTH_ENABLED = envFlag('MCP_OAUTH_ENABLED');

/** Strictly decode the dedicated partner export cursor HMAC key from base64. */
export function decodePartnerApiCursorSigningKey(value: string | undefined): Buffer | null {
  const trimmed = value?.trim();
  if (!trimmed || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(trimmed)) {
    return null;
  }
  const decoded = Buffer.from(trimmed, 'base64');
  return decoded.toString('base64') === trimmed ? decoded : null;
}

export const PARTNER_API_CURSOR_SIGNING_KEY =
  decodePartnerApiCursorSigningKey(process.env.PARTNER_API_CURSOR_SIGNING_KEY) ?? Buffer.alloc(0);

// Google Workspace identity tools. Defaults OFF everywhere; an org must also
// have an explicit google_workspace_connections row before any tool is usable.
// Gates tool registration (aiAgentSdkTools.ts) and the connect routes.
export const GOOGLE_WORKSPACE_ENABLED = envFlag('GOOGLE_WORKSPACE_ENABLED', false);

// Microsoft 365 identity tools. Defaults OFF everywhere; an org must also have
// an explicit m365_connections row before any tool is usable. Gates tool
// registration (aiAgentSdkTools.ts) and the connect routes.
export const M365_ENABLED = envFlag('M365_ENABLED', false);

// New customer Graph-read consent initiation is dark by default and rolled out
// independently per organization. Read at call time so disabling initiation
// does not require module reloads and does not gate existing connection flows.
export function m365CustomerGraphReadOnboardingEnabled(): boolean {
  return envFlag('M365_CUSTOMER_GRAPH_READ_ONBOARDING_ENABLED', false);
}

// Breeze AI for Office (Excel add-in / client AI). The Entra application
// (client) ID of the multi-tenant add-in app registration. Empty = the whole
// /client-ai surface is dark (exchange and admin routes return 404), mirroring
// the M365_ENABLED gating style.
export const CLIENT_AI_ENTRA_CLIENT_ID = process.env.CLIENT_AI_ENTRA_CLIENT_ID?.trim() ?? '';

export const QBO_CLIENT_ID = process.env.QBO_CLIENT_ID?.trim() ?? '';
export const QBO_CLIENT_SECRET = process.env.QBO_CLIENT_SECRET?.trim() ?? '';
export const QBO_REDIRECT_URI = process.env.QBO_REDIRECT_URI?.trim() ?? '';
export const QBO_ENVIRONMENT = process.env.QBO_ENVIRONMENT?.trim() ?? '';

// Read at call time so tests can flip `IS_HOSTED` per-test without `vi.resetModules()`.
export function isHosted(): boolean {
  return envFlag('IS_HOSTED');
}

// Recognizes an AFFIRMATIVE self-host declaration: IS_HOSTED explicitly set to
// a recognized falsey signal ('false'/'0'/'no'/'off'). Unset / empty / garbage /
// truthy all return false, so security-weakening, self-host-only features stay
// CLOSED unless self-host is positively declared. This is the #570 hardening
// lesson — an unmapped IS_HOSTED (value in .env but not threaded through compose)
// must never silently weaken security. Pure (takes the raw value) so callers
// reading a `source`/`data` object rather than process.env can reuse it.
// Mirrors the fail-closed gate in services/dnsProviders/index.ts.
export function isRecognizedSelfHostSignal(raw: string | undefined): boolean {
  return new Set(['0', 'false', 'no', 'off']).has((raw ?? '').trim().toLowerCase());
}

// Gate for "may this deployment reach RFC1918/ULA (and plain-HTTP) targets over
// safeFetch?" for the internal-OIDC/SSO discovery path (issue #2293). The DNS-
// provider (services/dnsProviders/index.ts) and PSA (services/psa/http.ts)
// integrations currently carry their own equivalent IS_HOSTED-affirmative gates
// — consolidating all three onto this helper is a worthwhile follow-up, but as
// of now this function is called only by the SSO routes. Opens ONLY when
// self-host is AFFIRMATIVELY declared; unset/empty/garbage/truthy IS_HOSTED
// stays strict (#570 fail-closed lesson). Loopback, link-local, cloud metadata,
// and CGNAT remain blocked in BOTH modes at the safeFetch/urlSafety layer
// regardless. `!isHosted()` is implied by the falsey-set membership but kept
// explicit so the truthy/falsey vocabularies can never drift apart silently.
export function selfHostAllowsPrivateNetwork(): boolean {
  return isRecognizedSelfHostSignal(process.env.IS_HOSTED) && !isHosted();
}

// Public URL of the breeze-billing payment-setup landing page. Empty on
// self-host. Consumed by the OAuth consent redirect (see Phase 2 Task 2.1
// of docs/superpowers/plans/onboarding-signup/2026-04-29-mcp-bootstrap-cleanup.md) — the
// consent handler redirects users to BILLING_URL?uid=<UID> when their
// partner.status != 'active'. Distinct from BREEZE_BILLING_URL, which is
// the internal service-to-service base URL used by breezeBillingClient.ts.
export const BILLING_URL = process.env.BILLING_URL ?? '';

// DCR (Dynamic Client Registration) defaults OFF in all environments.
// Production deployments must explicitly opt in by setting OAUTH_DCR_ENABLED=true,
// AND must then choose an anti-spam posture (boot-refused otherwise — see
// config/validate.ts), EITHER:
//   - OAUTH_DCR_REQUIRE_IAT=true  → every POST /oauth/reg needs an initial-
//     access-token issued out-of-band. Closes the public-spam vector, but is
//     INCOMPATIBLE with public MCP clients (Claude Desktop / claude.ai) that
//     register via anonymous RFC 7591 DCR and have no way to supply an IAT.
//   - OAUTH_DCR_ALLOW_ANONYMOUS=true → deliberately permit anonymous DCR. This
//     is the required posture for a public MCP server: anonymous DCR is the
//     only registration path Claude's connector can use. Residual spam risk is
//     bounded by the compensating controls already on /oauth/reg — per-IP rate
//     limiting (oauth.ts), forced public clients (token_endpoint_auth_method
//     'none'), mandatory PKCE S256, software_id rejection, and the daily GC of
//     stale unused clients (jobs/oauthCleanup.ts).
// Setting both is allowed (IAT wins at the provider); setting neither with DCR
// enabled is a boot-refused misconfig so an accidental deploy can't open an
// ungated registration endpoint.
export const OAUTH_DCR_ENABLED = envFlag('OAUTH_DCR_ENABLED', false);
export const OAUTH_DCR_REQUIRE_IAT = envFlag('OAUTH_DCR_REQUIRE_IAT', false);
export const OAUTH_DCR_ALLOW_ANONYMOUS = envFlag('OAUTH_DCR_ALLOW_ANONYMOUS', false);
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

// Cloudflare Access JWT trust on /auth/login (Discussion #702). Read at call
// time so tests can flip per-test without resetting modules.
export function cfAccessTrustEnabled(): boolean {
  return envFlag('CF_ACCESS_TRUST_ENABLED');
}
export function cfAccessTeamDomain(): string {
  return (process.env.CF_ACCESS_TEAM_DOMAIN ?? '').trim();
}
export function cfAccessAud(): string {
  return (process.env.CF_ACCESS_AUD ?? '').trim();
}
export function cfAccessTrustsMfa(): boolean {
  return envFlag('CF_ACCESS_TRUSTS_MFA');
}

// Emergency kill switches for ML/AI producers. These are intentionally read at
// call time so ops can flip process/runtime env and workers can stop writing
// outputs without a redeploy.
export function mlFeaturesGloballyDisabled(): boolean {
  return (
    envFlag('ML_FEATURES_DISABLED') ||
    envFlag('ML_OUTPUTS_DISABLED') ||
    envFlag('ML_GLOBAL_KILL_SWITCH')
  );
}

function mlFlagEnvNames(flag: string): string[] {
  const normalized = flag
    .replace(/^ml\./, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  const disabledName = `ML_${normalized}_DISABLED`;
  const names = [disabledName];
  if (disabledName.endsWith('_ENABLED_DISABLED')) {
    names.push(disabledName.replace(/_ENABLED_DISABLED$/, '_DISABLED'));
  }
  return names;
}

function isFlagListed(raw: string | undefined, flag: string): boolean {
  if (!raw) return false;
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .some((entry) => {
      if (entry === flag || entry === '*' || entry === 'ml.*') return true;
      if (entry.endsWith('.*')) return flag.startsWith(entry.slice(0, -1));
      return false;
    });
}

export function mlFeatureGloballyDisabled(flag: string): boolean {
  if (mlFeaturesGloballyDisabled()) return true;
  if (isFlagListed(process.env.ML_DISABLED_FLAGS, flag)) return true;
  return mlFlagEnvNames(flag).some((name) => envFlag(name));
}
