import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  M365_PERMISSION_PROFILES,
  type CompleteConsentRequest,
  type CompleteConsentResult,
} from '@breeze/shared/m365';
import { and, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
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
  applyIdentityVerificationResult,
  markConsentAttemptFailed,
  transitionAdminConsentToIdentity,
  type M365ConnectionSnapshot,
  type M365ConsentAttemptSnapshot,
} from '../services/m365ControlPlane/connectionService';
import {
  consumeConsentSession,
  hashTenantHint,
  prepareIdentityVerificationSession,
  type M365ConsentSession,
  type M365ConsentSessionProfile,
  type PreparedIdentityVerificationSession,
} from '../services/m365ControlPlane/consentSessionService';
import {
  createGraphActionsExecutorClient,
  type GraphActionsExecutorClientConfig,
} from '../services/m365ControlPlane/graphActionsExecutorClient';
import {
  createGraphReadExecutorClient,
  type GraphReadExecutorClientConfig,
} from '../services/m365ControlPlane/graphReadExecutorClient';
import { buildMicrosoftIdentityAuthorizationUrl } from '../services/m365ControlPlane/microsoftAuthorization';
import { loadM365CustomerGraphReadRuntimeConfig } from '../services/m365ControlPlane/runtimeConfig';
import { actionsConnectionService } from '../services/m365ControlPlane/writeActionConnectionService';
import { loadM365CustomerGraphActionsRuntimeConfig } from '../services/m365ControlPlane/writeActionRuntimeConfig';
import {
  recordM365CustomerGraphActionsEvent,
  recordM365CustomerGraphActionsMetric,
  recordM365CustomerGraphReadEvent,
  recordM365CustomerGraphReadMetric,
} from '../services/m365ControlPlane/metrics';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The two M365 profiles that run the two-phase consent callback. */
type CallbackProfile = M365ConsentSessionProfile;

/** Profile-parameterized snapshot types — one interface, narrowed per instance. */
type CallbackConnectionSnapshot = M365ConnectionSnapshot<CallbackProfile>;
type CallbackAttemptSnapshot = M365ConsentAttemptSnapshot<CallbackProfile>;

export type ParsedM365ConsentCallback =
  | { kind: 'admin_success'; state: string; tenantId: string }
  | { kind: 'identity_success'; state: string; code: string }
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

export function parseM365ConsentCallbackQuery(
  phase: M365ConsentBindingPhase,
  params: URLSearchParams,
): ParsedM365ConsentCallback | null {
  const keys = [...params.keys()];
  if (new Set(keys).size !== keys.length) return null;
  const state = single(params, 'state');
  if (!validOpaque(state, 256)) return null;

  const hasError = params.has('error');
  const successKeys = phase === 'admin_consent'
    ? new Set(['state', 'tenant', 'admin_consent'])
    : new Set(['state', 'code']);
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

  if (keys.some((key) => !successKeys.has(key)) || keys.length !== successKeys.size) return null;
  if (phase === 'admin_consent') {
    const tenantId = single(params, 'tenant');
    if (!tenantId || !GUID.test(tenantId) || single(params, 'admin_consent') !== 'true') return null;
    return { kind: 'admin_success', state, tenantId };
  }
  const code = single(params, 'code');
  if (!validOpaque(code, 8_192)) return null;
  return { kind: 'identity_success', state, code };
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

interface CallbackExecutorClient {
  completeIdentityVerification(input: CompleteConsentRequest): Promise<CompleteConsentResult>;
}

/** The subset of a profile-bound ConnectionService the callback route needs. */
interface CallbackConnectionServiceLike {
  markConsentAttemptFailed(
    input: CallbackAttemptSnapshot,
    errorCode: string,
  ): Promise<CallbackConnectionSnapshot>;
  transitionAdminConsentToIdentity(input: {
    attempt: CallbackAttemptSnapshot;
    rawAdminState: string;
    prepared: PreparedIdentityVerificationSession;
  }): Promise<{ connection: CallbackConnectionSnapshot; actorId: string }>;
  applyIdentityVerificationResult(
    input: CallbackAttemptSnapshot,
    result: CompleteConsentResult,
  ): Promise<CallbackConnectionSnapshot>;
}

interface CallbackEventNames {
  verificationFailed: string;
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
  actorId?: string;
}

interface CallbackDependencies {
  profile: CallbackProfile;
  redirectBase: string;
  events: CallbackEventNames;
  verifyBindingCookie(cookieHeader: string | undefined): M365ConsentBrowserBinding | 'expired' | null;
  buildBindingCookie(binding: M365ConsentBrowserBinding): string;
  clearBindingCookie(): string;
  loadAttempt(binding: M365ConsentBrowserBinding): Promise<CallbackAttemptSnapshot | null>;
  consumeSession(input: Parameters<typeof consumeConsentSession>[0]): Promise<M365ConsentSession | null>;
  markAttemptFailed(input: CallbackAttemptSnapshot, outcome: string): Promise<CallbackConnectionSnapshot>;
  prepareIdentitySession(input: { tenantHint: string }): PreparedIdentityVerificationSession;
  buildIdentityUrl(input: Parameters<typeof buildMicrosoftIdentityAuthorizationUrl>[0]): string;
  transitionAdminPhase(input: {
    attempt: CallbackAttemptSnapshot;
    rawAdminState: string;
    prepared: PreparedIdentityVerificationSession;
  }): Promise<{ connection: CallbackConnectionSnapshot; actorId: string }>;
  completeIdentity(input: CompleteConsentRequest): Promise<CompleteConsentResult>;
  applyIdentityResult(input: CallbackAttemptSnapshot, result: CompleteConsentResult): Promise<CallbackConnectionSnapshot>;
  loadConfig(): CallbackRuntimeConfig;
  correlationId(): string;
  audit(c: Context, input: CallbackAuditInput): void;
  metric(event: string, outcome: PublicOutcome): void;
}

/** Fixed per-profile event names — the audit/metric event enums are profile-scoped siblings. */
const CALLBACK_EVENT_NAMES: Record<CallbackProfile, CallbackEventNames> = {
  'customer-graph-read': {
    verificationFailed: 'm365.customer_graph_read.verification_failed',
    adminConsentReturned: 'm365.customer_graph_read.admin_consent_returned',
    tenantBindingVerified: 'm365.customer_graph_read.tenant_binding_verified',
    grantDriftDetected: 'm365.customer_graph_read.grant_drift_detected',
  },
  'customer-graph-actions': {
    verificationFailed: 'm365.customer_graph_actions.verification_failed',
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

function completeIdentityWithRuntime(
  loadRuntimeConfig: () => CallbackExecutorRuntimeConfig,
  createExecutorClient: (config: CallbackExecutorRuntimeConfig) => CallbackExecutorClient,
): (input: CompleteConsentRequest) => Promise<CompleteConsentResult> {
  return (input) => createExecutorClient(loadRuntimeConfig()).completeIdentityVerification(input);
}

function defaultLoadRuntimeConfig(profile: CallbackProfile): () => CallbackExecutorRuntimeConfig {
  return profile === 'customer-graph-actions'
    ? loadM365CustomerGraphActionsRuntimeConfig
    : loadM365CustomerGraphReadRuntimeConfig;
}

function defaultCreateExecutorClient(
  profile: CallbackProfile,
): (config: CallbackExecutorRuntimeConfig) => CallbackExecutorClient {
  if (profile === 'customer-graph-actions') {
    return (config) => createGraphActionsExecutorClient({
      executorUrl: config.executorUrl,
      executorAudience: config.executorAudience,
      signingPrivateJwk: config.executorSigningPrivateJwk,
      signingKid: config.executorSigningKid,
    } as GraphActionsExecutorClientConfig);
  }
  return (config) => createGraphReadExecutorClient({
    executorUrl: config.executorUrl,
    executorAudience: config.executorAudience,
    signingPrivateJwk: config.executorSigningPrivateJwk,
    signingKid: config.executorSigningKid,
  } as GraphReadExecutorClientConfig);
}

function defaultConnectionService(profile: CallbackProfile): CallbackConnectionServiceLike {
  return profile === 'customer-graph-actions'
    ? actionsConnectionService
    : { markConsentAttemptFailed, transitionAdminConsentToIdentity, applyIdentityVerificationResult };
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
      return inspected.status === 'valid' ? inspected.binding : null;
    },
    buildBindingCookie: (bound) => binding.build(bound),
    clearBindingCookie: () => binding.buildClear(),
    loadAttempt: buildLoadAttemptFromBinding(profile),
    consumeSession: consumeConsentSession,
    markAttemptFailed: connectionService.markConsentAttemptFailed,
    prepareIdentitySession: prepareIdentityVerificationSession,
    buildIdentityUrl: buildMicrosoftIdentityAuthorizationUrl,
    transitionAdminPhase: connectionService.transitionAdminConsentToIdentity,
    completeIdentity: completeIdentityWithRuntime(loadRuntimeConfig, createExecutorClient),
    applyIdentityResult: connectionService.applyIdentityVerificationResult,
    loadConfig: () => {
      const config = loadRuntimeConfig();
      return { clientId: config.clientId, callbackUrl: config.callbackUrl };
    },
    correlationId: randomUUID,
    audit: profile === 'customer-graph-actions' ? recordM365CustomerGraphActionsEvent : recordM365CustomerGraphReadEvent,
    metric: profile === 'customer-graph-actions' ? recordM365CustomerGraphActionsMetric : recordM365CustomerGraphReadMetric,
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

function errorOutcome(error: unknown): PublicOutcome {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'tenant_already_bound') return 'tenant_already_bound';
    if (code === 'stale_attempt') return 'consent_state_mismatch';
  }
  return 'executor_unavailable';
}

export interface CreateM365ConsentCallbackRoutesOverrides extends Partial<CallbackDependencies> {
  /** Full runtime-config loader (superset of `loadConfig`'s clientId/callbackUrl). */
  loadRuntimeConfig?: () => CallbackExecutorRuntimeConfig;
  /** Builds the executor client used to complete identity verification. */
  createExecutorClient?: (config: CallbackExecutorRuntimeConfig) => CallbackExecutorClient;
  /** Profile-bound connection-lifecycle service (markConsentAttemptFailed / transitionAdminConsentToIdentity / applyIdentityVerificationResult). */
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
          manifestVersion: M365_PERMISSION_PROFILES[dependencies.profile].version,
          outcome,
          correlationId,
          ...(actorId ? { actorId } : {}),
        });
      } else {
        dependencies.metric(dependencies.events.verificationFailed, outcome);
      }
      return terminalRedirect(outcome);
    };

    const binding = dependencies.verifyBindingCookie(c.req.header('cookie'));
    if (binding === 'expired') return terminalFailure('consent_expired');
    if (!binding) return terminalFailure('consent_state_mismatch');
    const parsed = parseM365ConsentCallbackQuery(
      binding.phase,
      new URL(c.req.url).searchParams,
    );
    if (!parsed || !constantTimeTextEqual(parsed.state, binding.rawState)) {
      return terminalFailure('consent_state_mismatch');
    }

    if (binding.phase === 'admin_consent' && parsed.kind === 'admin_success') {
      let prepared: PreparedIdentityVerificationSession;
      let preparedCookie: string;
      let authorizationUrl: string;
      try {
        const config = dependencies.loadConfig();
        prepared = dependencies.prepareIdentitySession({ tenantHint: parsed.tenantId });
        preparedCookie = dependencies.buildBindingCookie({
          phase: 'identity_verification',
          rawState: prepared.rawState,
          connectionId: binding.connectionId,
          consentAttemptId: binding.consentAttemptId,
          tenantHint: parsed.tenantId,
        });
        authorizationUrl = dependencies.buildIdentityUrl({
          tenantId: parsed.tenantId,
          clientId: config.clientId,
          redirectUri: config.callbackUrl,
          expectedCallbackPath,
          state: prepared.rawState,
          nonce: prepared.nonce,
          codeChallenge: prepared.codeChallenge,
        });
      } catch {
        dependencies.metric(dependencies.events.verificationFailed, 'executor_unavailable');
        return c.json({ error: 'M365 consent callback temporarily unavailable' }, 503);
      }

      const attempt = await dependencies.loadAttempt(binding);
      if (!attempt || attempt.status !== 'pending-consent') {
        return terminalFailure('consent_state_mismatch');
      }
      let actorId: string;
      try {
        const transitioned = await dependencies.transitionAdminPhase({
          attempt,
          rawAdminState: binding.rawState,
          prepared,
        });
        actorId = transitioned.actorId;
      } catch (error) {
        if (errorOutcome(error) === 'consent_state_mismatch') {
          return terminalFailure('consent_state_mismatch', attempt);
        }
        dependencies.metric(dependencies.events.verificationFailed, 'executor_unavailable');
        return c.json({ error: 'M365 consent callback temporarily unavailable' }, 503);
      }

      c.header('Set-Cookie', preparedCookie, { append: true });
      dependencies.audit(c, {
        event: dependencies.events.adminConsentReturned,
        orgId: attempt.orgId,
        connectionId: attempt.id,
        profile: attempt.profile,
        consentAttemptId: attempt.consentAttemptId,
        manifestVersion: M365_PERMISSION_PROFILES[dependencies.profile].version,
        outcome: 'identity_verification_started',
        correlationId,
        actorId,
      });
      return c.redirect(authorizationUrl);
    }

    const attempt = await dependencies.loadAttempt(binding);
    const expectedStatus = binding.phase === 'admin_consent' ? 'pending-consent' : 'verifying';
    if (!attempt || attempt.status !== expectedStatus) {
      return terminalFailure('consent_state_mismatch');
    }

    const session = await dependencies.consumeSession({
      rawState: binding.rawState,
      phase: binding.phase,
      connectionId: binding.connectionId,
      orgId: attempt.orgId,
      consentAttemptId: binding.consentAttemptId,
      profile: dependencies.profile,
    });
    if (!session) return terminalFailure('consent_state_mismatch', attempt);

    if (parsed.kind === 'provider_error') {
      try {
        await dependencies.markAttemptFailed(attempt, 'consent_cancelled');
      } catch {
        return terminalFailure('consent_state_mismatch', attempt, session.userId);
      }
      return terminalFailure('consent_cancelled', attempt, session.userId);
    }

    if (
      binding.phase !== 'identity_verification'
      || parsed.kind !== 'identity_success'
      || !binding.tenantHint
      || !session.tenantHintHash
      || !session.nonce
      || !session.codeVerifier
    ) return terminalFailure('consent_state_mismatch', attempt, session.userId);

    const actualTenantHash = hashTenantHint(binding.tenantHint);
    if (!constantTimeTextEqual(actualTenantHash, session.tenantHintHash)) {
      return terminalFailure('tenant_mismatch', attempt, session.userId);
    }

    let result: CompleteConsentResult;
    try {
      result = await dependencies.completeIdentity({
        correlationId,
        consentAttemptId: attempt.consentAttemptId,
        tenantHint: binding.tenantHint,
        authorizationCode: parsed.code,
        codeVerifier: session.codeVerifier,
        nonce: session.nonce,
        redirectUri: dependencies.loadConfig().callbackUrl,
      });
    } catch {
      try {
        await dependencies.markAttemptFailed(attempt, 'executor_unavailable');
      } catch {
        return terminalFailure('consent_state_mismatch', attempt, session.userId);
      }
      return terminalFailure('executor_unavailable', attempt, session.userId);
    }

    try {
      const applied = await dependencies.applyIdentityResult(attempt, result);
      const outcome = outcomeFromConnection(applied);
      if (result.success && (applied.status === 'active' || applied.status === 'degraded')) {
        const driftOutcome = applied.lastErrorCode === 'grant_missing'
          || applied.lastErrorCode === 'grant_unexpected'
          || applied.lastErrorCode === 'manifest_stale'
          ? applied.lastErrorCode
          : null;
        const event = {
          orgId: attempt.orgId,
          connectionId: attempt.id,
          profile: attempt.profile,
          consentAttemptId: attempt.consentAttemptId,
          manifestVersion: result.manifestVersion,
          correlationId,
          verifiedTenantId: result.tenantId,
          actorId: session.userId,
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
      return terminalFailure(outcome, attempt, session.userId);
    } catch (error) {
      return terminalFailure(errorOutcome(error), attempt, session.userId);
    }
  });

  return routes;
}

export const m365ConsentCallbackRoutes = createM365ConsentCallbackRoutes();

export const m365ActionsConsentCallbackRoutes = createM365ConsentCallbackRoutes({
  profile: 'customer-graph-actions',
  loadRuntimeConfig: loadM365CustomerGraphActionsRuntimeConfig,
  createExecutorClient: (config) => createGraphActionsExecutorClient({
    executorUrl: config.executorUrl,
    executorAudience: config.executorAudience,
    signingPrivateJwk: config.executorSigningPrivateJwk,
    signingKid: config.executorSigningKid,
  } as GraphActionsExecutorClientConfig),
  connectionService: actionsConnectionService,
});
