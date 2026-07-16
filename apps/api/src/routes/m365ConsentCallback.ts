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
  buildClearM365ConsentBindingCookie,
  buildM365ConsentBindingCookie,
  inspectM365ConsentBindingCookie,
  type M365ConsentBrowserBinding,
  type M365ConsentBindingPhase,
} from '../services/m365ControlPlane/browserBinding';
import {
  applyIdentityVerificationResult,
  markConsentAttemptFailed,
  transitionAdminConsentToIdentity,
  type ConsentAttemptSnapshot,
  type CustomerGraphReadConnectionSnapshot,
} from '../services/m365ControlPlane/connectionService';
import {
  consumeConsentSession,
  hashTenantHint,
  prepareIdentityVerificationSession,
  type M365ConsentSession,
  type PreparedIdentityVerificationSession,
} from '../services/m365ControlPlane/consentSessionService';
import { createGraphReadExecutorClient } from '../services/m365ControlPlane/graphReadExecutorClient';
import { buildMicrosoftIdentityAuthorizationUrl } from '../services/m365ControlPlane/microsoftAuthorization';
import {
  loadM365CustomerGraphReadRuntimeConfig,
  type M365CustomerGraphReadRuntimeConfig,
} from '../services/m365ControlPlane/runtimeConfig';
import {
  recordM365CustomerGraphReadEvent,
  recordM365CustomerGraphReadMetric,
  type M365CustomerGraphReadAuditInput,
  type M365CustomerGraphReadEvent,
} from '../services/m365ControlPlane/metrics';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

interface CallbackDependencies {
  verifyBindingCookie(cookieHeader: string | undefined): M365ConsentBrowserBinding | 'expired' | null;
  buildBindingCookie(binding: M365ConsentBrowserBinding): string;
  clearBindingCookie(): string;
  loadAttempt(binding: M365ConsentBrowserBinding): Promise<ConsentAttemptSnapshot | null>;
  consumeSession(input: Parameters<typeof consumeConsentSession>[0]): Promise<M365ConsentSession | null>;
  markAttemptFailed(input: ConsentAttemptSnapshot, outcome: string): Promise<CustomerGraphReadConnectionSnapshot>;
  prepareIdentitySession(input: { tenantHint: string }): PreparedIdentityVerificationSession;
  buildIdentityUrl(input: Parameters<typeof buildMicrosoftIdentityAuthorizationUrl>[0]): string;
  transitionAdminPhase(input: Parameters<typeof transitionAdminConsentToIdentity>[0]): ReturnType<typeof transitionAdminConsentToIdentity>;
  completeIdentity(input: CompleteConsentRequest): Promise<CompleteConsentResult>;
  applyIdentityResult(input: ConsentAttemptSnapshot, result: CompleteConsentResult): Promise<CustomerGraphReadConnectionSnapshot>;
  loadConfig(): CallbackRuntimeConfig;
  correlationId(): string;
  audit(c: Context, input: M365CustomerGraphReadAuditInput): void;
  metric(event: M365CustomerGraphReadEvent, outcome: PublicOutcome): void;
}

async function loadAttemptFromBinding(
  binding: M365ConsentBrowserBinding,
): Promise<ConsentAttemptSnapshot | null> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const rows = await db.select().from(m365Connections).where(and(
      eq(m365Connections.id, binding.connectionId),
      eq(m365Connections.profile, 'customer-graph-read'),
      eq(m365Connections.consentAttemptId, binding.consentAttemptId),
    )).limit(1);
    const row = rows[0];
    if (!row?.orgId || !row.consentAttemptId || row.profile !== 'customer-graph-read') return null;
    return {
      id: row.id,
      orgId: row.orgId,
      profile: 'customer-graph-read',
      consentAttemptId: row.consentAttemptId,
      status: row.status,
    };
  }));
}

function completeIdentityWithRuntime(input: CompleteConsentRequest): Promise<CompleteConsentResult> {
  const config: M365CustomerGraphReadRuntimeConfig = loadM365CustomerGraphReadRuntimeConfig();
  return createGraphReadExecutorClient({
    executorUrl: config.executorUrl,
    executorAudience: config.executorAudience,
    signingPrivateJwk: config.executorSigningPrivateJwk,
    signingKid: config.executorSigningKid,
  }).completeIdentityVerification(input);
}

const defaultDependencies: CallbackDependencies = {
  verifyBindingCookie: (header) => {
    const inspected = inspectM365ConsentBindingCookie(header);
    if (inspected.status === 'expired') return 'expired';
    return inspected.status === 'valid' ? inspected.binding : null;
  },
  buildBindingCookie: (binding) => buildM365ConsentBindingCookie(binding),
  clearBindingCookie: () => buildClearM365ConsentBindingCookie(),
  loadAttempt: loadAttemptFromBinding,
  consumeSession: consumeConsentSession,
  markAttemptFailed: markConsentAttemptFailed,
  prepareIdentitySession: prepareIdentityVerificationSession,
  buildIdentityUrl: buildMicrosoftIdentityAuthorizationUrl,
  transitionAdminPhase: transitionAdminConsentToIdentity,
  completeIdentity: completeIdentityWithRuntime,
  applyIdentityResult: applyIdentityVerificationResult,
  loadConfig: loadM365CustomerGraphReadRuntimeConfig,
  correlationId: randomUUID,
  audit: recordM365CustomerGraphReadEvent,
  metric: recordM365CustomerGraphReadMetric,
};

function constantTimeTextEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function outcomeFromConnection(value: CustomerGraphReadConnectionSnapshot): PublicOutcome {
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

export function createM365ConsentCallbackRoutes(
  overrides: Partial<CallbackDependencies> = {},
): Hono {
  const dependencies = { ...defaultDependencies, ...overrides };
  const routes = new Hono();

  routes.get('/consent/callback', async (c) => {
    const correlationId = dependencies.correlationId();
    const terminalRedirect = (outcome: PublicOutcome) => {
      c.header('Set-Cookie', dependencies.clearBindingCookie(), { append: true });
      return c.redirect(`/integrations#m365/customer-graph-read/${outcome}`);
    };
    const terminalFailure = (
      outcome: PublicOutcome,
      attempt?: ConsentAttemptSnapshot,
      actorId?: string,
    ) => {
      if (attempt) {
        dependencies.audit(c, {
          event: 'm365.customer_graph_read.verification_failed',
          orgId: attempt.orgId,
          connectionId: attempt.id,
          profile: attempt.profile,
          consentAttemptId: attempt.consentAttemptId,
          manifestVersion: M365_PERMISSION_PROFILES['customer-graph-read'].version,
          outcome,
          correlationId,
          ...(actorId ? { actorId } : {}),
        });
      } else {
        dependencies.metric('m365.customer_graph_read.verification_failed', outcome);
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
          state: prepared.rawState,
          nonce: prepared.nonce,
          codeChallenge: prepared.codeChallenge,
        });
      } catch {
        dependencies.metric('m365.customer_graph_read.verification_failed', 'executor_unavailable');
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
        dependencies.metric('m365.customer_graph_read.verification_failed', 'executor_unavailable');
        return c.json({ error: 'M365 consent callback temporarily unavailable' }, 503);
      }

      c.header('Set-Cookie', preparedCookie, { append: true });
      dependencies.audit(c, {
        event: 'm365.customer_graph_read.admin_consent_returned',
        orgId: attempt.orgId,
        connectionId: attempt.id,
        profile: attempt.profile,
        consentAttemptId: attempt.consentAttemptId,
        manifestVersion: M365_PERMISSION_PROFILES['customer-graph-read'].version,
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
          event: 'm365.customer_graph_read.tenant_binding_verified',
          outcome,
        });
        if (driftOutcome) {
          dependencies.audit(c, {
            ...event,
            event: 'm365.customer_graph_read.grant_drift_detected',
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
