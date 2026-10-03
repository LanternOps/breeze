import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  M365_PERMISSION_PROFILES,
  type RetestRequest,
  type RetestResult,
  type VerifyConsentIdentityRequest,
  type VerifyConsentIdentityResult,
} from '@breeze/shared/m365';
import { and, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { isM365TenantSyncEnabled } from '../config/env';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { m365Connections } from '../db/schema';
import {
  buildClearM365ActionsConsentBindingCookie,
  buildClearM365ConsentBindingCookie,
  buildM365ActionsConsentBindingCookie,
  buildM365ConsentBindingCookie,
  inspectM365ActionsConsentBindingCookie,
  inspectM365ConsentBindingCookie,
  type M365ConsentBrowserBinding,
  type M365ConsentBindingPhase,
} from '../services/m365ControlPlane/browserBinding';
import {
  applyConsentFinalizationResult,
  applyUpgradeFinalizationResult,
  beginConsentFinalization,
  markConsentAttemptFailed,
  transitionIdentityToConsent,
  type ConsentFinalization,
  type M365ConnectionSnapshot,
  type M365ConsentAttemptSnapshot,
  type StartedConsentFinalization,
} from '../services/m365ControlPlane/connectionService';
import {
  consumeConsentSession,
  hashTenantHint,
  readConsentSessionPurpose,
  type ConsentSessionPurposeLookup,
  type M365ConsentPurpose,
  type M365ConsentSession,
  type M365ConsentSessionProfile,
  type VerifiedConsentIdentity,
} from '../services/m365ControlPlane/consentSessionService';
import {
  createGraphActionsExecutorClient,
  type GraphActionsExecutorClientConfig,
} from '../services/m365ControlPlane/graphActionsExecutorClient';
import {
  createGraphReadExecutorClient,
  type GraphReadExecutorClientConfig,
} from '../services/m365ControlPlane/graphReadExecutorClient';
import {
  buildMicrosoftTenantAdminConsentUrl,
  type TenantAdminConsentUrlInput,
} from '../services/m365ControlPlane/microsoftAuthorization';
import { loadM365CustomerGraphReadRuntimeConfig } from '../services/m365ControlPlane/runtimeConfig';
import { actionsConnectionService } from '../services/m365ControlPlane/writeActionConnectionService';
import { loadM365CustomerGraphActionsRuntimeConfig } from '../services/m365ControlPlane/writeActionRuntimeConfig';
import {
  recordM365CustomerGraphActionsEvent,
  recordM365CustomerGraphActionsMetric,
  recordM365CustomerGraphReadEvent,
  recordM365CustomerGraphReadMetric,
} from '../services/m365ControlPlane/metrics';
import { onConnectionConsented, onConnectionUpgraded } from '../services/m365Sync/lifecycle';

/**
 * Identity-first admin consent callback (#7910), shared by both certificate
 * profiles. Two phases return to the same profile-scoped callback path:
 *
 *   identity_verification — v2 OIDC code. Handed to the profile executor's
 *     `verify-identity`, which redeems it and cryptographically verifies the
 *     administrator's id_token (tid/oid/roles). The verified identity is
 *     stored server-side under a rotated one-use state and the browser is sent
 *     to Microsoft's v1 tenant-pinned admin-consent screen for THAT tenant.
 *   admin_consent — v1 authorize return. The returned authorization code is
 *     dropped by the parser's caller and never redeemed, forwarded, persisted,
 *     logged, or audited; consent is proven instead by the executor's
 *     application-token probe (`retest`) against the verified tenant, and only
 *     then is the tenant bound.
 */

/** The two M365 profiles that run the two-phase consent callback. */
type CallbackProfile = M365ConsentSessionProfile;

/** Profile-parameterized snapshot types — one interface, narrowed per instance. */
type CallbackConnectionSnapshot = M365ConnectionSnapshot<CallbackProfile>;
type CallbackAttemptSnapshot = M365ConsentAttemptSnapshot<CallbackProfile>;

export type ParsedM365ConsentCallback =
  /** Same shape for both phases; the admin-consent phase's code is discarded. */
  | { kind: 'code_success'; state: string; code: string }
  | { kind: 'provider_error'; state: string };

function single(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  return values.length === 1 ? values[0]! : null;
}

function validOpaque(value: string | null, maxLength: number): value is string {
  return value !== null
    && value.length > 0
    && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/.test(value);
}

/**
 * Strict allowlist parser. Both phases are authorization-code responses with
 * `response_mode=query`; any other key (including the legacy
 * `/adminconsent` `tenant` / `admin_consent` pair) fails closed so an
 * unauthenticated tenant hint can never re-enter the flow.
 */
export function parseM365ConsentCallbackQuery(
  _phase: M365ConsentBindingPhase,
  params: URLSearchParams,
): ParsedM365ConsentCallback | null {
  const keys = [...params.keys()];
  if (new Set(keys).size !== keys.length) return null;
  const state = single(params, 'state');
  if (!validOpaque(state, 256)) return null;

  const hasError = params.has('error');
  const successKeys = new Set(['state', 'code', 'session_state']);
  const errorKeys = new Set(['state', 'error', 'error_description']);

  if (hasError) {
    if (keys.some((key) => !errorKeys.has(key))) return null;
    const error = single(params, 'error');
    const description = params.has('error_description')
      ? single(params, 'error_description')
      : '';
    if (!validOpaque(error, 128) || description === null || description.length > 4_096) return null;
    return { kind: 'provider_error', state };
  }

  if (keys.some((key) => !successKeys.has(key))) return null;
  const code = single(params, 'code');
  if (!validOpaque(code, 8_192)) return null;
  // Entra commonly appends session_state to a successful authorization-code
  // response. It is not used as authority by Breeze, but validate and accept
  // the bounded opaque value rather than rejecting Microsoft's normal shape.
  if (params.has('session_state') && !validOpaque(single(params, 'session_state'), 256)) return null;
  return { kind: 'code_success', state, code };
}

type PublicOutcome =
  | 'active'
  | 'degraded'
  | 'consent_expired'
  | 'consent_state_mismatch'
  | 'consent_cancelled'
  | 'admin_role_required'
  | 'tenant_mismatch'
  | 'tenant_already_bound'
  | 'credential_unavailable'
  | 'identity_token_invalid'
  | 'application_token_invalid'
  | 'grant_reconciliation_unavailable'
  | 'grant_missing'
  | 'grant_unexpected'
  | 'manifest_stale'
  | 'organization_probe_failed'
  | 'executor_unavailable';

const PUBLIC_OUTCOMES = new Set<PublicOutcome>([
  'active', 'degraded', 'consent_expired', 'consent_state_mismatch',
  'consent_cancelled', 'admin_role_required', 'tenant_mismatch',
  'tenant_already_bound', 'credential_unavailable', 'identity_token_invalid',
  'application_token_invalid', 'grant_reconciliation_unavailable', 'grant_missing',
  'grant_unexpected', 'manifest_stale', 'organization_probe_failed', 'executor_unavailable',
]);
interface CallbackRuntimeConfig {
  clientId: string;
  callbackUrl: string;
}

/**
 * Superset of CallbackRuntimeConfig carrying the executor-signing fields both
 * the read and actions runtime configs expose. Kept loose (string audience)
 * so both profile-specific configs satisfy it structurally; the strict
 * literal audience is only required at the point each concrete executor
 * client constructor is called.
 */
interface CallbackExecutorRuntimeConfig extends CallbackRuntimeConfig {
  executorUrl: string;
  executorAudience: string;
  executorSigningPrivateJwk: Record<string, unknown>;
  executorSigningKid: string;
}

/** The two executor operations the callback drives, adapted per profile. */
interface CallbackExecutorClient {
  verifyConsentIdentity(input: VerifyConsentIdentityRequest): Promise<VerifyConsentIdentityResult>;
  retest(input: RetestRequest): Promise<RetestResult>;
}

/** The subset of a profile-bound ConnectionService the callback route needs. */
interface CallbackConnectionServiceLike {
  markConsentAttemptFailed(
    input: CallbackAttemptSnapshot,
    errorCode: string,
  ): Promise<CallbackConnectionSnapshot>;
  transitionIdentityToConsent(input: {
    attempt: CallbackAttemptSnapshot;
    purpose: M365ConsentPurpose;
    actorId: string;
    verified: VerifiedConsentIdentity;
    nextPhase: 'admin_consent' | 'tenant_confirmation';
  }): Promise<{ rawState: string; verifiedTenantId: string }>;
  beginConsentFinalization(input: {
    attempt: CallbackAttemptSnapshot;
    rawConsentState: string;
  }): Promise<StartedConsentFinalization<CallbackProfile>>;
  applyConsentFinalizationResult(
    input: CallbackAttemptSnapshot,
    finalization: ConsentFinalization,
  ): Promise<CallbackConnectionSnapshot>;
  applyUpgradeFinalizationResult(
    input: CallbackAttemptSnapshot,
    finalization: ConsentFinalization,
  ): Promise<{ connection: CallbackConnectionSnapshot; failureCode: string | null }>;
}

interface CallbackEventNames {
  verificationFailed: string;
  adminIdentityVerified: string;
  adminConsentReturned: string;
  tenantBindingVerified: string;
  grantDriftDetected: string;
}

interface CallbackAuditInput {
  event: string;
  orgId: string;
  connectionId: string;
  profile: CallbackProfile;
  consentAttemptId: string;
  manifestVersion?: number;
  outcome: string;
  correlationId?: string;
  verifiedTenantId?: string;
  verifiedAdministratorObjectId?: string;
  actorId?: string;
}

/** `legacy` = a correctly-signed cookie from the pre-identity-first flow. */
type BindingVerification = M365ConsentBrowserBinding | 'expired' | 'legacy' | null;

interface CallbackDependencies {
  profile: CallbackProfile;
  redirectBase: string;
  events: CallbackEventNames;
  verifyBindingCookie(cookieHeader: string | undefined): BindingVerification;
  buildBindingCookie(binding: M365ConsentBrowserBinding): string;
  clearBindingCookie(): string;
  loadAttempt(binding: M365ConsentBrowserBinding): Promise<CallbackAttemptSnapshot | null>;
  consumeSession(input: Parameters<typeof consumeConsentSession>[0]): Promise<M365ConsentSession | null>;
  /**
   * Reads which flow this callback is resuming without consuming the session.
   * Needed BEFORE the attempt status is validated, because an upgrade session
   * expects an executable connection and a first-time session expects
   * pending-consent (spec §2.2).
   */
  readSessionPurpose(input: ConsentSessionPurposeLookup): Promise<M365ConsentPurpose | null>;
  markAttemptFailed(input: CallbackAttemptSnapshot, outcome: string): Promise<CallbackConnectionSnapshot>;
  /** Phase 1: executor `verify-identity` (redeem the v2 code, verify the id_token). */
  verifyIdentity(input: VerifyConsentIdentityRequest): Promise<VerifyConsentIdentityResult>;
  transitionIdentityToConsent: CallbackConnectionServiceLike['transitionIdentityToConsent'];
  buildConsentUrl(input: TenantAdminConsentUrlInput): string;
  beginFinalization: CallbackConnectionServiceLike['beginConsentFinalization'];
  /** Phase 2 proof: executor `retest` (application token + probe + grants) against the verified tenant. */
  finalize(input: RetestRequest): Promise<RetestResult>;
  applyFinalization: CallbackConnectionServiceLike['applyConsentFinalizationResult'];
  applyUpgradeFinalization: CallbackConnectionServiceLike['applyUpgradeFinalizationResult'];
  loadConfig(): CallbackRuntimeConfig;
  correlationId(): string;
  audit(c: Context, input: CallbackAuditInput): void;
  metric(event: string, outcome: PublicOutcome): void;
  /**
   * Tenant-sync lifecycle (W05, spec §5.8). A verified first-time/re-consent
   * seeds the sync; an upgrade that promoted the manifest re-arms domains
   * parked on needs_consent. No-ops for the actions profile: the sync reads
   * exclusively through the customer-graph-read connection.
   */
  onSyncConsented(conn: { id: string; orgId: string; tenantId: string; status: 'active' | 'degraded' }): Promise<void>;
  onSyncUpgraded(conn: { id: string; orgId: string }): Promise<void>;
}

const NO_SYNC_HOOK = async (): Promise<void> => {};

/**
 * Spec §10.1: every sync entry point is flag-gated, and a Microsoft consent
 * that actually succeeded must never redirect the administrator to a failure
 * page because our scheduler had a bad minute. The lifecycle hooks already log
 * and never throw by contract; this is the belt to that brace, and the ticker's
 * reconciliation re-seeds on the next tick either way.
 */
async function runSyncLifecycleHook(label: string, run: () => Promise<void>): Promise<void> {
  if (!isM365TenantSyncEnabled()) return;
  try {
    await run();
  } catch (err) {
    console.error(`[m365ConsentCallback] ${label} failed:`, err);
  }
}

/** Fixed per-profile event names — the audit/metric event enums are profile-scoped siblings. */
const CALLBACK_EVENT_NAMES: Record<CallbackProfile, CallbackEventNames> = {
  'customer-graph-read': {
    verificationFailed: 'm365.customer_graph_read.verification_failed',
    adminIdentityVerified: 'm365.customer_graph_read.admin_identity_verified',
    adminConsentReturned: 'm365.customer_graph_read.admin_consent_returned',
    tenantBindingVerified: 'm365.customer_graph_read.tenant_binding_verified',
    grantDriftDetected: 'm365.customer_graph_read.grant_drift_detected',
  },
  'customer-graph-actions': {
    verificationFailed: 'm365.customer_graph_actions.verification_failed',
    adminIdentityVerified: 'm365.customer_graph_actions.admin_identity_verified',
    adminConsentReturned: 'm365.customer_graph_actions.admin_consent_returned',
    tenantBindingVerified: 'm365.customer_graph_actions.tenant_binding_verified',
    grantDriftDetected: 'm365.customer_graph_actions.grant_drift_detected',
  },
};

/**
 * Builds the profile-scoped attempt lookup: the WHERE clause pins both the
 * connection id AND the profile column, so a binding minted for one profile
 * can never resolve an attempt row that belongs to the other — even though
 * the browser-binding cookie itself carries no profile field.
 */
function buildLoadAttemptFromBinding(
  profile: CallbackProfile,
): (binding: M365ConsentBrowserBinding) => Promise<CallbackAttemptSnapshot | null> {
  return async function loadAttemptFromBinding(
    binding: M365ConsentBrowserBinding,
  ): Promise<CallbackAttemptSnapshot | null> {
    return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
      const rows = await db.select().from(m365Connections).where(and(
        eq(m365Connections.id, binding.connectionId),
        eq(m365Connections.profile, profile),
        eq(m365Connections.consentAttemptId, binding.consentAttemptId),
      )).limit(1);
      const row = rows[0];
      if (!row?.orgId || !row.consentAttemptId || row.profile !== profile) return null;
      return {
        id: row.id,
        orgId: row.orgId,
        profile,
        consentAttemptId: row.consentAttemptId,
        status: row.status,
      };
    }));
  };
}

function defaultLoadRuntimeConfig(profile: CallbackProfile): () => CallbackExecutorRuntimeConfig {
  return profile === 'customer-graph-actions'
    ? loadM365CustomerGraphActionsRuntimeConfig
    : loadM365CustomerGraphReadRuntimeConfig;
}

/**
 * Per-profile executor adapter. The read executor is only ever reached from
 * the read instance and the actions executor only from the actions instance
 * (credential-domain separation).
 */
function defaultCreateExecutorClient(
  profile: CallbackProfile,
): (config: CallbackExecutorRuntimeConfig) => CallbackExecutorClient {
  if (profile === 'customer-graph-actions') {
    return (config) => {
      const client = createGraphActionsExecutorClient({
        executorUrl: config.executorUrl,
        executorAudience: config.executorAudience,
        signingPrivateJwk: config.executorSigningPrivateJwk,
        signingKid: config.executorSigningKid,
      } as GraphActionsExecutorClientConfig);
      return {
        verifyConsentIdentity: (input) => client.verifyConsentIdentity(input),
        retest: (input) => client.retestCustomerGraphActions(input),
      };
    };
  }
  return (config) => {
    const client = createGraphReadExecutorClient({
      executorUrl: config.executorUrl,
      executorAudience: config.executorAudience,
      signingPrivateJwk: config.executorSigningPrivateJwk,
      signingKid: config.executorSigningKid,
    } as GraphReadExecutorClientConfig);
    return {
      verifyConsentIdentity: (input) => client.verifyConsentIdentity(input),
      retest: (input) => client.retestCustomerGraphRead(input),
    };
  };
}

function defaultConnectionService(profile: CallbackProfile): CallbackConnectionServiceLike {
  return profile === 'customer-graph-actions'
    ? actionsConnectionService
    : {
      markConsentAttemptFailed,
      transitionIdentityToConsent,
      beginConsentFinalization,
      applyConsentFinalizationResult,
      applyUpgradeFinalizationResult,
    };
}

/**
 * Profile-scoped binding functions. Each profile has its own cookie name,
 * cookie Path, and HMAC context (see browserBinding.ts) — the actions
 * instance never builds, clears, or verifies the read instance's cookie
 * and vice versa, so a browser only ever round-trips the correct cookie to
 * the correct callback path, and a cross-profile replay fails signature
 * verification even if forged past Path scoping.
 */
function defaultBindingFunctions(profile: CallbackProfile): {
  inspect: typeof inspectM365ConsentBindingCookie;
  build: typeof buildM365ConsentBindingCookie;
  buildClear: typeof buildClearM365ConsentBindingCookie;
} {
  return profile === 'customer-graph-actions'
    ? {
      inspect: inspectM365ActionsConsentBindingCookie,
      build: buildM365ActionsConsentBindingCookie,
      buildClear: buildClearM365ActionsConsentBindingCookie,
    }
    : {
      inspect: inspectM365ConsentBindingCookie,
      build: buildM365ConsentBindingCookie,
      buildClear: buildClearM365ConsentBindingCookie,
    };
}

function buildDefaultDependencies(
  profile: CallbackProfile,
  loadRuntimeConfig: () => CallbackExecutorRuntimeConfig,
  createExecutorClient: (config: CallbackExecutorRuntimeConfig) => CallbackExecutorClient,
  connectionService: CallbackConnectionServiceLike,
): CallbackDependencies {
  const binding = defaultBindingFunctions(profile);
  return {
    profile,
    redirectBase: `/integrations#m365/${profile}`,
    events: CALLBACK_EVENT_NAMES[profile],
    verifyBindingCookie: (header) => {
      const inspected = binding.inspect(header);
      if (inspected.status === 'expired') return 'expired';
      if (inspected.status === 'legacy') return 'legacy';
      return inspected.status === 'valid' ? inspected.binding : null;
    },
    buildBindingCookie: (bound) => binding.build(bound),
    clearBindingCookie: () => binding.buildClear(),
    loadAttempt: buildLoadAttemptFromBinding(profile),
    consumeSession: consumeConsentSession,
    readSessionPurpose: readConsentSessionPurpose,
    markAttemptFailed: connectionService.markConsentAttemptFailed,
    verifyIdentity: (input) => createExecutorClient(loadRuntimeConfig()).verifyConsentIdentity(input),
    transitionIdentityToConsent: connectionService.transitionIdentityToConsent,
    buildConsentUrl: buildMicrosoftTenantAdminConsentUrl,
    beginFinalization: connectionService.beginConsentFinalization,
    finalize: (input) => createExecutorClient(loadRuntimeConfig()).retest(input),
    applyFinalization: connectionService.applyConsentFinalizationResult,
    applyUpgradeFinalization: connectionService.applyUpgradeFinalizationResult,
    loadConfig: () => {
      const config = loadRuntimeConfig();
      return { clientId: config.clientId, callbackUrl: config.callbackUrl };
    },
    correlationId: randomUUID,
    audit: profile === 'customer-graph-actions' ? recordM365CustomerGraphActionsEvent : recordM365CustomerGraphReadEvent,
    metric: profile === 'customer-graph-actions' ? recordM365CustomerGraphActionsMetric : recordM365CustomerGraphReadMetric,
    onSyncConsented: profile === 'customer-graph-read' ? onConnectionConsented : NO_SYNC_HOOK,
    onSyncUpgraded: profile === 'customer-graph-read' ? onConnectionUpgraded : NO_SYNC_HOOK,
  };
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function outcomeFromConnection(value: CallbackConnectionSnapshot): PublicOutcome {
  if (value.status === 'active') return 'active';
  if (value.status === 'degraded') return 'degraded';
  return PUBLIC_OUTCOMES.has(value.lastErrorCode as PublicOutcome)
    ? value.lastErrorCode as PublicOutcome
    : 'executor_unavailable';
}

/**
 * Statuses a callback may legally act on. Identity-first never moves a
 * first-time attempt off `pending-consent` until consent has returned (and
 * then only inside beginConsentFinalization), so BOTH phases expect
 * `pending-consent`; an upgrade never moves the connection at all.
 */
function statusAllowed(status: string, isUpgrade: boolean): boolean {
  if (isUpgrade) return status === 'active' || status === 'degraded';
  return status === 'pending-consent';
}

/**
 * An upgrade leaves an executable connection executable even when it fails, so
 * status alone would report `active` for an approval that granted nothing.
 * Whether the stored manifest version actually moved is the real outcome.
 *
 * `failureCode` is the reason the apply returned in band. It matters because
 * every upgrade failure is a deliberate no-op on the row: without it a
 * wrong-tenant or wrong-application consent would be reported to the
 * administrator with the same generic "manifest is stale" copy as never having
 * started, and the specific per-cause copy the UI already ships would be
 * unreachable.
 */
function upgradeOutcome(
  value: CallbackConnectionSnapshot,
  currentManifestVersion: number,
  failureCode: string | null,
): PublicOutcome {
  if (value.permissionManifestVersion !== currentManifestVersion) {
    for (const candidate of [failureCode, value.lastErrorCode]) {
      if (PUBLIC_OUTCOMES.has(candidate as PublicOutcome)) return candidate as PublicOutcome;
    }
    return 'manifest_stale';
  }
  return outcomeFromConnection(value);
}

function lifecycleCode(error: unknown): string | null {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'tenant_already_bound' || code === 'stale_attempt' || code === 'tenant_mismatch') return code;
  }
  return null;
}

function errorOutcome(error: unknown): PublicOutcome {
  const code = lifecycleCode(error);
  if (code === 'tenant_already_bound') return 'tenant_already_bound';
  if (code === 'tenant_mismatch') return 'tenant_mismatch';
  if (code === 'stale_attempt') return 'consent_state_mismatch';
  return 'executor_unavailable';
}

export interface CreateM365ConsentCallbackRoutesOverrides extends Partial<CallbackDependencies> {
  /** Full runtime-config loader (superset of `loadConfig`'s clientId/callbackUrl). */
  loadRuntimeConfig?: () => CallbackExecutorRuntimeConfig;
  /** Builds the executor client used for verify-identity and the finalization retest. */
  createExecutorClient?: (config: CallbackExecutorRuntimeConfig) => CallbackExecutorClient;
  /** Profile-bound connection-lifecycle service. */
  connectionService?: CallbackConnectionServiceLike;
}

export function createM365ConsentCallbackRoutes(
  overrides: CreateM365ConsentCallbackRoutesOverrides = {},
): Hono {
  const profile = overrides.profile ?? 'customer-graph-read';
  const loadRuntimeConfig = overrides.loadRuntimeConfig ?? defaultLoadRuntimeConfig(profile);
  const createExecutorClient = overrides.createExecutorClient ?? defaultCreateExecutorClient(profile);
  const connectionService = overrides.connectionService ?? defaultConnectionService(profile);

  const dependencies: CallbackDependencies = {
    ...buildDefaultDependencies(profile, loadRuntimeConfig, createExecutorClient, connectionService),
    ...overrides,
  };
  const routes = new Hono();
  const callbackPath = dependencies.profile === 'customer-graph-actions'
    ? '/actions-consent/callback'
    : '/consent/callback';
  // Full mounted pathname — must match the redirect_uri Microsoft is sent back to
  // (config.callbackUrl), which microsoftAuthorization.ts's requireRedirectUri
  // validates against exactly. The read and actions instances mount distinct
  // suffixes under the same '/m365' base (see index.ts).
  const expectedCallbackPath = `/api/v1/m365${callbackPath}`;
  const currentManifestVersion = M365_PERMISSION_PROFILES[dependencies.profile].version;

  routes.get(callbackPath, async (c) => {
    const correlationId = dependencies.correlationId();
    const terminalRedirect = (outcome: PublicOutcome) => {
      c.header('Set-Cookie', dependencies.clearBindingCookie(), { append: true });
      return c.redirect(`${dependencies.redirectBase}/${outcome}`);
    };
    const terminalFailure = (
      outcome: PublicOutcome,
      attempt?: CallbackAttemptSnapshot,
      actorId?: string,
    ) => {
      if (attempt) {
        dependencies.audit(c, {
          event: dependencies.events.verificationFailed,
          orgId: attempt.orgId,
          connectionId: attempt.id,
          profile: attempt.profile,
          consentAttemptId: attempt.consentAttemptId,
          manifestVersion: currentManifestVersion,
          outcome,
          correlationId,
          ...(actorId ? { actorId } : {}),
        });
      } else {
        dependencies.metric(dependencies.events.verificationFailed, outcome);
      }
      return terminalRedirect(outcome);
    };
    const temporarilyUnavailable = () => {
      dependencies.metric(dependencies.events.verificationFailed, 'executor_unavailable');
      return c.json({ error: 'M365 consent callback temporarily unavailable' }, 503);
    };
    /**
     * Records why a first-time attempt failed (pending-consent + error code)
     * and redirects. An upgrade must leave its live connection exactly as it
     * was — markAttemptFailed writes status = 'pending-consent', which would
     * take a working connection out of service (spec §2.2).
     */
    const failAttempt = async (
      outcome: PublicOutcome,
      attempt: CallbackAttemptSnapshot,
      isUpgrade: boolean,
      actorId: string,
    ) => {
      if (!isUpgrade) {
        try {
          await dependencies.markAttemptFailed(attempt, outcome);
        } catch {
          return terminalFailure('consent_state_mismatch', attempt, actorId);
        }
      }
      return terminalFailure(outcome, attempt, actorId);
    };

    const binding = dependencies.verifyBindingCookie(c.req.header('cookie'));
    if (binding === 'expired' || binding === 'legacy') {
      // A legacy cookie is an in-flight attempt from before the identity-first
      // deploy; like an expired one, the only remedy is an explicit restart.
      console.warn('[m365ConsentCallback] browser binding expired', {
        profile: dependencies.profile,
        correlationId,
        legacy: binding === 'legacy',
      });
      return terminalFailure('consent_expired');
    }
    if (!binding) {
      console.warn('[m365ConsentCallback] browser binding missing or invalid', {
        profile: dependencies.profile,
        correlationId,
        cookieHeaderPresent: Boolean(c.req.header('cookie')),
      });
      return terminalFailure('consent_state_mismatch');
    }
    const parsed = parseM365ConsentCallbackQuery(
      binding.phase,
      new URL(c.req.url).searchParams,
    );
    if (!parsed || !constantTimeTextEqual(parsed.state, binding.rawState)) {
      console.warn('[m365ConsentCallback] callback query did not match browser binding', {
        profile: dependencies.profile,
        phase: binding.phase,
        correlationId,
        parsed: Boolean(parsed),
      });
      return terminalFailure('consent_state_mismatch');
    }

    const purpose = await dependencies.readSessionPurpose({
      rawState: binding.rawState,
      phase: binding.phase,
      connectionId: binding.connectionId,
      consentAttemptId: binding.consentAttemptId,
      profile: dependencies.profile,
    });
    // A missing session is not an upgrade; the consume below fails it anyway.
    const isUpgrade = purpose === 'upgrade';

    const attempt = await dependencies.loadAttempt(binding);
    if (!attempt || !statusAllowed(attempt.status, isUpgrade)) {
      return terminalFailure('consent_state_mismatch');
    }

    // ---- Phase 1: identity verification -----------------------------------
    if (binding.phase === 'identity_verification') {
      let config: CallbackRuntimeConfig;
      try {
        config = dependencies.loadConfig();
      } catch {
        return temporarilyUnavailable();
      }

      const session = await dependencies.consumeSession({
        rawState: binding.rawState,
        phase: 'identity_verification',
        connectionId: binding.connectionId,
        orgId: attempt.orgId,
        consentAttemptId: binding.consentAttemptId,
        profile: dependencies.profile,
      });
      if (!session) return terminalFailure('consent_state_mismatch', attempt);
      // The consumed row is the authority on which flow this is; the
      // non-consuming lookup above only routed us here.
      if ((session.purpose === 'upgrade') !== isUpgrade) {
        return terminalFailure('consent_state_mismatch', attempt, session.userId);
      }
      const actorId = session.userId;

      if (parsed.kind === 'provider_error') {
        return failAttempt('consent_cancelled', attempt, isUpgrade, actorId);
      }
      if (!session.nonce || !session.codeVerifier) {
        return terminalFailure('consent_state_mismatch', attempt, actorId);
      }

      // The authority the sign-in was pinned to (bound tenant) or null for
      // /organizations must agree between the signed cookie and the
      // server-side session before the executor is called.
      const expectedTenantId = binding.tenantId;
      const authorityMatches = expectedTenantId === null
        ? session.tenantHintHash === null
        : session.tenantHintHash !== null
          && constantTimeTextEqual(hashTenantHint(expectedTenantId), session.tenantHintHash);
      if (!authorityMatches) {
        return failAttempt('tenant_mismatch', attempt, isUpgrade, actorId);
      }

      let identity: VerifyConsentIdentityResult;
      try {
        identity = await dependencies.verifyIdentity({
          correlationId,
          consentAttemptId: attempt.consentAttemptId,
          expectedTenantId,
          authorizationCode: parsed.code,
          codeVerifier: session.codeVerifier,
          nonce: session.nonce,
          redirectUri: config.callbackUrl,
        });
      } catch {
        // Includes a pre-W1 executor that 404s /v1/verify-identity.
        return failAttempt('executor_unavailable', attempt, isUpgrade, actorId);
      }
      if (!identity.success) {
        return failAttempt(identity.errorCode, attempt, isUpgrade, actorId);
      }
      // The executor already enforces the pinned tenant; this is the belt.
      if (expectedTenantId !== null && identity.tenantId !== expectedTenantId) {
        return failAttempt('tenant_mismatch', attempt, isUpgrade, actorId);
      }
      const verified: VerifiedConsentIdentity = {
        tenantId: identity.tenantId,
        administratorObjectId: identity.administratorObjectId,
        administratorUsername: identity.administratorUsername,
        verifiedAt: new Date(identity.verifiedAt),
      };

      dependencies.audit(c, {
        event: dependencies.events.adminIdentityVerified,
        orgId: attempt.orgId,
        connectionId: attempt.id,
        profile: attempt.profile,
        consentAttemptId: attempt.consentAttemptId,
        manifestVersion: currentManifestVersion,
        outcome: 'identity_verified',
        correlationId,
        verifiedTenantId: verified.tenantId,
        verifiedAdministratorObjectId: verified.administratorObjectId,
        actorId,
      });

      let consentState: string;
      try {
        // W3 (Task 14) inserts the confirm-tenant interstitial here for
        // /organizations sign-ins; W2 continues straight to consent.
        const transitioned = await dependencies.transitionIdentityToConsent({
          attempt,
          purpose: session.purpose,
          actorId,
          verified,
          nextPhase: 'admin_consent',
        });
        consentState = transitioned.rawState;
      } catch (error) {
        const outcome = errorOutcome(error);
        if (outcome === 'consent_state_mismatch') return terminalFailure(outcome, attempt, actorId);
        return failAttempt(outcome, attempt, isUpgrade, actorId);
      }

      let consentCookie: string;
      let consentUrl: string;
      try {
        consentCookie = dependencies.buildBindingCookie({
          phase: 'admin_consent',
          rawState: consentState,
          connectionId: attempt.id,
          consentAttemptId: attempt.consentAttemptId,
          tenantId: verified.tenantId,
        });
        consentUrl = dependencies.buildConsentUrl({
          tenantId: verified.tenantId,
          clientId: config.clientId,
          redirectUri: config.callbackUrl,
          expectedCallbackPath,
          state: consentState,
        });
      } catch {
        return failAttempt('executor_unavailable', attempt, isUpgrade, actorId);
      }
      c.header('Set-Cookie', consentCookie, { append: true });
      return c.redirect(consentUrl);
    }

    // ---- Phase 2: tenant-pinned admin consent returned --------------------
    if (parsed.kind === 'provider_error') {
      const session = await dependencies.consumeSession({
        rawState: binding.rawState,
        phase: 'admin_consent',
        connectionId: binding.connectionId,
        orgId: attempt.orgId,
        consentAttemptId: binding.consentAttemptId,
        profile: dependencies.profile,
      });
      if (!session) return terminalFailure('consent_state_mismatch', attempt);
      if ((session.purpose === 'upgrade') !== isUpgrade) {
        return terminalFailure('consent_state_mismatch', attempt, session.userId);
      }
      return failAttempt('consent_cancelled', attempt, isUpgrade, session.userId);
    }
    // parsed.code is deliberately never read past this point: the consent
    // phase's authorization code is discarded, never redeemed or recorded.

    let started: StartedConsentFinalization<CallbackProfile>;
    try {
      started = await dependencies.beginFinalization({ attempt, rawConsentState: binding.rawState });
    } catch (error) {
      if (lifecycleCode(error) === null) {
        // Nothing was consumed (the consume and the CAS share a rolled-back
        // transaction), so the same callback stays retryable.
        return temporarilyUnavailable();
      }
      return terminalFailure(errorOutcome(error), attempt);
    }
    const { actorId, verified } = started;
    const working = started.attempt;
    if ((started.purpose === 'upgrade') !== isUpgrade) {
      return terminalFailure('consent_state_mismatch', working, actorId);
    }
    if (!binding.tenantId || !constantTimeTextEqual(verified.tenantId, binding.tenantId)) {
      return failAttempt('tenant_mismatch', working, isUpgrade, actorId);
    }

    // Records only that consent returned and the proof is starting — never
    // that the verified administrator granted it (Breeze cannot observe who
    // clicked Accept on Microsoft's consent screen).
    dependencies.audit(c, {
      event: dependencies.events.adminConsentReturned,
      orgId: working.orgId,
      connectionId: working.id,
      profile: working.profile,
      consentAttemptId: working.consentAttemptId,
      manifestVersion: currentManifestVersion,
      outcome: 'application_verification_started',
      correlationId,
      verifiedTenantId: verified.tenantId,
      actorId,
    });

    let result: RetestResult;
    try {
      result = await dependencies.finalize({ correlationId, tenantId: verified.tenantId });
    } catch {
      return failAttempt('executor_unavailable', working, isUpgrade, actorId);
    }

    const finalization: ConsentFinalization = { verifiedTenantId: verified.tenantId, result };
    try {
      let applied: CallbackConnectionSnapshot;
      let outcome: PublicOutcome;
      let upgradeFailureCode: string | null = null;
      if (isUpgrade) {
        const upgraded = await dependencies.applyUpgradeFinalization(working, finalization);
        applied = upgraded.connection;
        upgradeFailureCode = upgraded.failureCode;
        // Spec §5.8: the in-place promotion may have granted the scopes some
        // domains were parked on needs_consent for; re-arm them. Only when the
        // apply did not fail in band (a failed upgrade is a deliberate no-op on
        // the row). Idempotent: it touches only rows that are BOTH unscheduled
        // and needs_consent, so an approval that granted nothing costs one
        // indexed UPDATE of zero rows.
        if (upgradeFailureCode === null) {
          await runSyncLifecycleHook(
            `sync re-seed for connection=${working.id}`,
            () => dependencies.onSyncUpgraded({ id: working.id, orgId: working.orgId }),
          );
        }
        outcome = upgradeOutcome(applied, currentManifestVersion, upgradeFailureCode);
      } else {
        applied = await dependencies.applyFinalization(working, finalization);
        // A verified first-time (or re-)consent seeds all six domains due now
        // at priority 1, for `degraded` as well as `active` — a connection
        // missing one optional grant still syncs every other domain.
        const seededStatus = applied.status;
        const seededTenant = applied.tenantId;
        if (result.success && seededTenant && (seededStatus === 'active' || seededStatus === 'degraded')) {
          await runSyncLifecycleHook(
            `sync seeding for connection=${working.id}`,
            () => dependencies.onSyncConsented({
              id: working.id, orgId: working.orgId, tenantId: seededTenant, status: seededStatus,
            }),
          );
        }
        outcome = outcomeFromConnection(applied);
      }
      // An upgrade that did not promote is a FAILED verification even though
      // the executor reported success and the connection is still executable —
      // reporting it as tenant_binding_verified would log a wrong-tenant
      // consent attempt as a verified binding.
      if (isUpgrade && upgradeFailureCode !== null) {
        return terminalFailure(outcome, working, actorId);
      }
      if (result.success && (applied.status === 'active' || applied.status === 'degraded')) {
        const driftOutcome = applied.lastErrorCode === 'grant_missing'
          || applied.lastErrorCode === 'grant_unexpected'
          || applied.lastErrorCode === 'manifest_stale'
          ? applied.lastErrorCode
          : null;
        const event = {
          orgId: working.orgId,
          connectionId: working.id,
          profile: working.profile,
          consentAttemptId: working.consentAttemptId,
          manifestVersion: result.manifestVersion,
          correlationId,
          verifiedTenantId: verified.tenantId,
          // The administrator whose identity was verified in phase 1 — not a
          // claim about who granted consent.
          verifiedAdministratorObjectId: verified.administratorObjectId,
          actorId,
        } as const;
        dependencies.audit(c, {
          ...event,
          event: dependencies.events.tenantBindingVerified,
          outcome,
        });
        if (driftOutcome) {
          dependencies.audit(c, {
            ...event,
            event: dependencies.events.grantDriftDetected,
            outcome: driftOutcome,
          });
        }
        return terminalRedirect(outcome);
      }
      return terminalFailure(outcome, working, actorId);
    } catch (error) {
      return terminalFailure(errorOutcome(error), working, actorId);
    }
  });

  return routes;
}

export const m365ConsentCallbackRoutes = createM365ConsentCallbackRoutes();

export const m365ActionsConsentCallbackRoutes = createM365ConsentCallbackRoutes({
  profile: 'customer-graph-actions',
  loadRuntimeConfig: loadM365CustomerGraphActionsRuntimeConfig,
  connectionService: actionsConnectionService,
});
