import { EVENT_SUBSCRIBER_IDS, isSubscriberId, type SubscriberId } from '../services/eventSubscriberIds';

// The single truthy/falsey vocabulary for boolean-ish env vars. Kept as two
// named sets rather than inline literals so a reader that must distinguish
// "explicitly off" from "unrecognized" (abuseSignalsEnabled below) can never
// drift from what envFlag() itself accepts. Matches the boolean typo-guards in
// config/validate.ts.
const RECOGNIZED_TRUE_FLAG_VALUES: ReadonlySet<string> = new Set(['1', 'true', 'yes', 'on']);
const RECOGNIZED_FALSE_FLAG_VALUES: ReadonlySet<string> = new Set(['0', 'false', 'no', 'off']);

export function envFlag(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return RECOGNIZED_TRUE_FLAG_VALUES.has(raw.trim().toLowerCase());
}

export type RemoteAccessAdmissionMode = 'open' | 'closed';
export type RemoteWsRuntimeAuthMode = 'post_upgrade' | 'pre_upgrade';
export type RemoteWsRedisTopology = 'standalone-single-primary';

function requiredEnum<T extends string>(
  source: NodeJS.ProcessEnv,
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = source[name]?.trim();
  const productionLike = (
    source.NODE_ENV === 'production'
    || source.DEPLOYMENT_ENV === 'staging'
  );
  if (!raw) {
    if (productionLike) throw new Error(`${name} is required`);
    return fallback;
  }
  if (!allowed.includes(raw as T)) {
    throw new Error(`${name} must be one of: ${allowed.join(', ')}`);
  }
  return raw as T;
}

export function getRemoteWsRuntimeConfig(
  source: NodeJS.ProcessEnv = process.env,
): {
  admissionMode: RemoteAccessAdmissionMode;
  authMode: RemoteWsRuntimeAuthMode;
  redisTopology: RemoteWsRedisTopology;
  legacyTicketWriterDrainedAt: string | undefined;
  legacyViewerIssuerDrainedAt: string | undefined;
} {
  return {
    admissionMode: requiredEnum(
      source,
      'REMOTE_ACCESS_ADMISSION_MODE',
      ['open', 'closed'] as const,
      'open',
    ),
    authMode: requiredEnum(
      source,
      'REMOTE_WS_AUTH_MODE',
      ['post_upgrade', 'pre_upgrade'] as const,
      'post_upgrade',
    ),
    redisTopology: requiredEnum(
      source,
      'REMOTE_WS_REDIS_TOPOLOGY',
      ['standalone-single-primary'] as const,
      'standalone-single-primary',
    ),
    legacyTicketWriterDrainedAt:
      source.REMOTE_WS_LEGACY_TICKET_WRITER_DRAINED_AT?.trim() || undefined,
    legacyViewerIssuerDrainedAt:
      source.REMOTE_WS_LEGACY_VIEWER_ISSUER_DRAINED_AT?.trim() || undefined,
  };
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

// AI operator (spec docs/superpowers/specs/ai-mcp/2026-08-22-ai-agents-program-and-wave1-design.md §5.1).
// Platform kill switch: false forces every effective agent to enabled=false.
// Default OFF until the wave-3 runner ships.
export const AI_AGENTS_ENABLED = envFlag('BREEZE_AI_AGENTS_ENABLED', false);

// Wave 5 Part B (#3827). Sub-flag of BREEZE_AI_AGENTS_ENABLED: gates
// attemptPolicyDecision (policyDecide.ts) — an agent-originated, supervised-
// scope action-intent whose operation is in the operator's per-agent
// actAssets.supervisedActionKeys ⊆ POLICY_DECIDABLE_TIER3 is authorized by
// policy instead of human fanout. Default OFF (dark-ship): when false,
// resolvePolicyDecisionState returns 'human_required' exactly as Part A —
// byte-identical to the merged behavior before this wave (Global
// Constraints, plan header). Read at CALL time, like isHosted()/breezeRole()
// above, so a test can flip it per-case without vi.resetModules().
export function policyDecideEnabled(): boolean {
  return envFlag('BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED', false);
}

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

// New customer Graph-actions consent initiation is dark by default and rolled
// out independently per organization. Read at call time so disabling
// initiation does not require module reloads and does not gate existing
// connection flows.
export function m365CustomerGraphActionsOnboardingEnabled(): boolean {
  return envFlag('M365_CUSTOMER_GRAPH_ACTIONS_ONBOARDING_ENABLED', false);
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
// Intuit's shared-secret used to verify inbound CDC webhook signatures
// (Phase D). '' when unset — a region without the Intuit webhook configured
// relies entirely on the 15-minute reconcile sweep instead.
export const QBO_WEBHOOK_VERIFIER_TOKEN = process.env.QBO_WEBHOOK_VERIFIER_TOKEN?.trim() ?? '';

// Read at call time so tests can flip `IS_HOSTED` per-test without `vi.resetModules()`.
export function isHosted(): boolean {
  return envFlag('IS_HOSTED');
}

// Signup-abuse detection (services/abuseSignals) is a HOSTED-operator concern:
// it exists to police untrusted public signups on a multi-tenant service. A
// self-hosted install is normally one IT team managing its own machines, where
// the same heuristics are mostly noise or actively wrong —
// `invariant.active_no_payment` (services/abuseSignals/invariants.ts: every
// `status='active'` partner with a NULL `payment_method_attached_at`) fires on
// every partner forever, because self-host has no billing writer at all: the
// partner is created `active` directly at email verification (`status:
// rec.hostedExpectation ? 'pending' : 'active'` in routes/auth/verifyEmail.ts)
// and nothing on a self-hosted deployment ever stamps that column.
// `rmm.device_ip_scatter` just describes remote workers, and the fleet-shape
// detectors flag an ordinary lab of unnamed test VMs.
//
// (Deliberately NOT phrased as "payment_method_attached_at is only written by
// X" — an unqualified claim of exactly that shape about this column was proven
// false in production and is now retracted at length in
// services/partnerActivation.ts. The column additionally has an in-repo writer,
// routes/internal/synthetic.ts. The self-host argument above needs neither
// claim: no writer runs there at all.)
//
// So it defaults to `isHosted()` rather than being on for everyone. Note this
// keys off the TRUTHY reading of IS_HOSTED, not the affirmative-self-host
// helper below: the failure that matters here is a hosted deployment silently
// NOT policing its signups, so an unset/garbage IS_HOSTED leaves detection off
// entirely rather than half-configured. Be aware that "off" is quiet: the only
// artifact is one `[AbuseSignals] Disabled` line at boot from
// jobs/abuseSignalsSweep.ts — no alert, no /health field — so an operator who
// expected detection has to go read the startup logs to discover it isn't
// running. That is the opposite polarity from selfHostAllowsPrivateNetwork,
// which fails closed toward *strictness* because there the risk runs the other
// way.
//
// ABUSE_SIGNALS_ENABLED overrides in both directions, so a self-hoster running
// a genuine multi-tenant service can opt in, and a hosted deployment can switch
// the subsystem off without a redeploy. Only the RECOGNIZED vocabularies count:
// an unrecognized value (`ture`, `enabled`) falls through to the IS_HOSTED
// default with a warning rather than reading as "off", because the previous
// `envFlag`-based override turned a hosted deployment's detection OFF on any
// typo — precisely the silent-non-policing failure this comment says the
// default exists to avoid. config/validate.ts refuses boot on such a value, so
// the fallback here is only reachable in a process that skipped the validator.
// Empty stays "unset" on purpose: both compose files inject the key as
// `${ABUSE_SIGNALS_ENABLED:-}`, so "" is what the majority of stacks pass.
export function abuseSignalsEnabled(): boolean {
  const raw = (process.env.ABUSE_SIGNALS_ENABLED ?? '').trim();
  if (raw === '') return isHosted();
  const normalized = raw.toLowerCase();
  if (RECOGNIZED_TRUE_FLAG_VALUES.has(normalized)) return true;
  if (RECOGNIZED_FALSE_FLAG_VALUES.has(normalized)) return false;
  console.warn(
    `[AbuseSignals] Ignoring unrecognized ABUSE_SIGNALS_ENABLED value ${JSON.stringify(raw)} ` +
      '— expected true/false, 1/0, yes/no or on/off. Falling back to the IS_HOSTED default.',
  );
  return isHosted();
}

// True ONLY for an affirmative opt-out: ABUSE_SIGNALS_ENABLED explicitly set to
// a recognized falsey value. Unset / empty / unrecognized / truthy all return
// false, so this is strictly narrower than `!abuseSignalsEnabled()` — the
// default-off self-host path and the typo path are both excluded.
//
// Exists so a caller can distinguish "the operator turned this off" from
// "detection merely isn't running here" before taking an action that is
// destructive or otherwise not safe to perform on the ambiguous default (the
// abuse queue's Redis teardown, jobs/abuseSignalsSweep.ts). Intentionally
// unused inside this module.
export function abuseSignalsExplicitlyDisabled(): boolean {
  return RECOGNIZED_FALSE_FLAG_VALUES.has(
    (process.env.ABUSE_SIGNALS_ENABLED ?? '').trim().toLowerCase(),
  );
}

export type EventDispatchMode = 'off' | 'shadow' | 'enforce';

/** Wave 3.5c (#4085). off = today's in-process delivery only. shadow = mirror
 * routing plans into receipts, execute nothing via the queue. enforce = the
 * subscribers listed in EVENT_DISPATCH_QUEUE_SUBSCRIBERS deliver via BullMQ
 * ONLY (skipped locally); everyone else stays local. Unrecognized values fall
 * back to 'off' with a warning — a typo must never silently change delivery. */
export function eventDispatchMode(): EventDispatchMode {
  const raw = (process.env.EVENT_DISPATCH_MODE ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'off') return 'off';
  if (raw === 'shadow' || raw === 'enforce') return raw;
  console.warn(`[config] EVENT_DISPATCH_MODE="${raw}" is not off|shadow|enforce — treating as off`);
  return 'off';
}

export function eventDispatchQueueSubscribers(): ReadonlySet<SubscriberId> {
  const raw = (process.env.EVENT_DISPATCH_QUEUE_SUBSCRIBERS ?? '').trim();
  const out = new Set<SubscriberId>();
  if (raw === '') return out;
  for (const part of raw.split(',').map((p) => p.trim()).filter(Boolean)) {
    if (isSubscriberId(part)) out.add(part);
    else console.warn(`[config] EVENT_DISPATCH_QUEUE_SUBSCRIBERS contains unknown id "${part}" (known: ${EVENT_SUBSCRIBER_IDS.join(', ')}) — ignoring`);
  }
  return out;
}

export type BreezeRole = 'all' | 'api' | 'worker';

/**
 * Process role for the 3.5d split (#4086). `all` (default) = today's
 * all-in-one process. Introduced in 3.5b (#4084) so socket-local dispatch can
 * fail LOUDLY in a worker-role process instead of silently reporting every
 * agent offline.
 */
export function breezeRole(): BreezeRole {
  const raw = (process.env.BREEZE_ROLE ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'all') return 'all';
  if (raw === 'api' || raw === 'worker') return raw;
  console.warn(`[config] BREEZE_ROLE="${raw}" is not all|api|worker — treating as all`);
  return 'all';
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
  return RECOGNIZED_FALSE_FLAG_VALUES.has((raw ?? '').trim().toLowerCase());
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

export interface OAuthAuthEpochDeadlineOptions {
  oauthEnabled: boolean;
  nodeEnv: string | undefined;
}

export function parseOAuthAuthEpochEnforceAfter(
  raw: string | undefined,
  options: OAuthAuthEpochDeadlineOptions,
): Date | null {
  const value = raw?.trim() ?? '';
  const strictEnvironment = options.nodeEnv === 'production' || options.nodeEnv === 'staging';
  if (!value) {
    if (options.oauthEnabled && strictEnvironment) {
      throw new Error(
        'OAUTH_AUTH_EPOCH_ENFORCE_AFTER is required when MCP OAuth is enabled in production or staging',
      );
    }
    return null;
  }

  // Require a complete timestamp and an explicit UTC/offset suffix. A local
  // timestamp would move the compatibility boundary with host timezone.
  const absoluteIso =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
  const timestamp = Date.parse(value);
  if (!absoluteIso.test(value) || !Number.isFinite(timestamp)) {
    throw new Error('OAUTH_AUTH_EPOCH_ENFORCE_AFTER must be a valid absolute ISO timestamp');
  }
  return new Date(timestamp);
}

// Import-time resolution must never THROW, for two reasons:
//   1. config/validate.ts imports this module. A module-scope throw here runs
//      before the boot validator can collect and report every misconfigured
//      key, replacing an actionable aggregated message with a bare import
//      stack trace — and skipping the rest of the checks entirely.
//   2. env.ts is imported by jobs, seeds, scripts and unrelated test suites
//      that merely want one unrelated constant. Any of them running with
//      NODE_ENV=production would die on import even though they never touch
//      OAuth or event sockets.
// The authoritative "required in production" and "must be a valid absolute
// ISO timestamp" refusals therefore live in config/validate.ts, which runs
// first in bootstrap(). The fallback below is only reachable in a process that
// bypassed that validator, so it takes the CLOSED value: a deadline already in
// the past rejects every claimless legacy access token.
function resolveOAuthAuthEpochEnforceAfterAtImport(): Date | null {
  try {
    return parseOAuthAuthEpochEnforceAfter(process.env.OAUTH_AUTH_EPOCH_ENFORCE_AFTER, {
      oauthEnabled: MCP_OAUTH_ENABLED,
      nodeEnv: process.env.NODE_ENV,
    });
  } catch {
    return new Date(0);
  }
}

export const OAUTH_AUTH_EPOCH_ENFORCE_AFTER = resolveOAuthAuthEpochEnforceAfterAtImport();

export type EventPermissionEpochMode = 'compat' | 'enforce';

export function parseEventPermissionEpochMode(
  raw: string | undefined,
  nodeEnv: string | undefined,
): EventPermissionEpochMode {
  const value = raw?.trim().toLowerCase();
  const strictEnvironment = nodeEnv === 'production' || nodeEnv === 'staging';
  if (!value) {
    if (strictEnvironment) {
      throw new Error(
        'EVENT_PERMISSION_EPOCH_MODE is required in production and staging',
      );
    }
    return 'compat';
  }
  if (value !== 'compat' && value !== 'enforce') {
    throw new Error('EVENT_PERMISSION_EPOCH_MODE must be compat or enforce');
  }
  return value;
}

// Non-throwing at import for the same reasons as the OAuth deadline above;
// config/validate.ts owns the boot refusal. The fallback is the CLOSED mode:
// `enforce` rejects tickets that carry no permissions epoch, whereas `compat`
// still accepts version-one tickets.
function resolveEventPermissionEpochModeAtImport(): EventPermissionEpochMode {
  try {
    return parseEventPermissionEpochMode(
      process.env.EVENT_PERMISSION_EPOCH_MODE,
      process.env.NODE_ENV,
    );
  } catch {
    return 'enforce';
  }
}

export const EVENT_PERMISSION_EPOCH_MODE = resolveEventPermissionEpochModeAtImport();

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

const CF_ACCESS_TEAM_DOMAIN_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;

/** Accept only the canonical bare hostname Cloudflare assigns to one team. */
export function canonicalCfAccessTeamDomain(raw: string): string | null {
  if (!raw || raw !== raw.trim() || !CF_ACCESS_TEAM_DOMAIN_PATTERN.test(raw)) return null;
  try {
    const parsed = new URL(`https://${raw}`);
    if (
      parsed.username
      || parsed.password
      || parsed.port
      || parsed.pathname !== '/'
      || parsed.search
      || parsed.hash
      || parsed.hostname !== raw
    ) return null;
    return parsed.hostname;
  } catch {
    return null;
  }
}

export function cfAccessTeamDomain(): string {
  return canonicalCfAccessTeamDomain(process.env.CF_ACCESS_TEAM_DOMAIN ?? '') ?? '';
}
export function cfAccessAud(): string {
  return (process.env.CF_ACCESS_AUD ?? '').trim();
}
export function cfAccessTrustsMfa(): boolean {
  return envFlag('CF_ACCESS_TRUSTS_MFA');
}

// Browser authentication transition rollout. Both switches are deliberately
// read at call time and default off; validation prevents terminal preparation
// from being enabled before transition enforcement.
export function authBrowserTransitionsEnforced(): boolean {
  return envFlag('AUTH_BROWSER_TRANSITIONS_ENFORCED', false);
}

export function authBrowserTerminalPreparationEnabled(): boolean {
  return envFlag('AUTH_BROWSER_TERMINAL_PREPARATION_ENABLED', false);
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
