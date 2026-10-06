import {
  M365_PERMISSION_PROFILES,
  type CanonicalAppRoleAssignment,
  type M365ApplicationGrant,
} from '@breeze/shared/m365';
import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { zValidator } from '../lib/validation';
import {
  authMiddleware,
  requireMfa,
  requirePermission,
  type AuthContext,
} from '../middleware/auth';
import {
  deriveGrantHealth,
  type GrantHealthState,
  type GrantHealth,
  type M365ConnectionSnapshot,
} from '../services/m365ControlPlane/connectionService';
import {
  cancelCustomerGraphActionsTenantConfirmation,
  continueCustomerGraphActionsConsent,
  disconnectCustomerGraphActionsConnection,
  initiateCustomerGraphActionsConsent,
  listCustomerGraphActionsConnections,
  readPendingCustomerGraphActionsTenantConfirmation,
  retestCustomerGraphActionsConnection,
} from '../services/m365ControlPlane/writeActionConnectionService';
import { canMutateOrgWideGovernance, SITE_CEILING_WRITE_DENIED_MESSAGE } from '../services/siteCeilingAccess';
import { buildM365ActionsConsentBindingCookie } from '../services/m365ControlPlane/browserBinding';
import { isM365CustomerGraphActionsOnboardingEnabledForOrg } from '../services/m365ControlPlane/writeActionRuntimeConfig';
import {
  canManagePartnerWidePolicies,
  PARTNER_WIDE_WRITE_DENIED_MESSAGE,
} from '../services/partnerWideAccess';
import { PERMISSIONS } from '../services/permissions';
import {
  M365_CUSTOMER_GRAPH_ACTIONS_OUTCOMES,
  recordM365CustomerGraphActionsEvent,
  type M365CustomerGraphActionsOutcome,
} from '../services/m365ControlPlane/metrics';

import { isHoldingOrg } from '../services/unassignedPool/protectedOrg';
import { PROTECTED_ORG_ERROR } from '../services/unassignedPool/orgType';
const PROFILE_ID = 'customer-graph-actions' as const;
const PROFILE_DISPLAY_NAME = 'Customer Graph Actions';
const profileManifest = M365_PERMISSION_PROFILES[PROFILE_ID];
const requireOrgsRead = requirePermission(
  PERMISSIONS.ORGS_READ.resource,
  PERMISSIONS.ORGS_READ.action,
);
const requireOrgsWrite = requirePermission(
  PERMISSIONS.ORGS_WRITE.resource,
  PERMISSIONS.ORGS_WRITE.action,
);
const idParam = z.object({ id: z.string().uuid() });
const CANONICAL_ORG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_OUTCOMES = new Set<string>(M365_CUSTOMER_GRAPH_ACTIONS_OUTCOMES);
const GRANT_DRIFT_OUTCOMES = new Set<M365CustomerGraphActionsOutcome>([
  'grant_missing', 'grant_unexpected', 'manifest_stale',
]);

type CustomerGraphActionsConnectionSnapshot = M365ConnectionSnapshot<'customer-graph-actions'>;

function connectionOutcome(
  value: CustomerGraphActionsConnectionSnapshot,
): M365CustomerGraphActionsOutcome {
  if (value.status === 'active') return 'active';
  if (value.status === 'revoked') return 'revoked';
  if (value.lastErrorCode && SAFE_OUTCOMES.has(value.lastErrorCode)) {
    return value.lastErrorCode as M365CustomerGraphActionsOutcome;
  }
  if (value.status === 'degraded') return 'degraded';
  return 'executor_unavailable';
}

export interface CustomerGraphActionsConnectionDto {
  id: string;
  tenantId: string | null;
  clientId: string | null;
  displayName: string | null;
  status: CustomerGraphActionsConnectionSnapshot['status'];
  /**
   * Derived health, not stored status. `manifest-stale` is the state the
   * upgrade-consent banner keys off: the connection is executing fine on the
   * grants it has, but the code manifest has moved on (spec §2.2).
   */
  grantHealth: GrantHealthState;
  /** Manifest version stored on the row. */
  manifestVersion: number;
  /** Manifest version this build requires. */
  currentManifestVersion: number;
  observedGrants: CanonicalAppRoleAssignment[];
  missingGrants: CanonicalAppRoleAssignment[];
  unexpectedGrants: CanonicalAppRoleAssignment[];
  grantsVerifiedAt: string | null;
  lastVerifiedAt: string | null;
  lastErrorCode: string | null;
}

export interface CustomerGraphActionsEnvelope {
  profile: {
    id: typeof PROFILE_ID;
    displayName: string;
    // Was a hard-coded literal, which stops compiling the moment the manifest
    // moves. The manifest is the single source; the DTO reports it.
    manifestVersion: number;
    requiredGrants: M365ApplicationGrant[];
  };
  onboardingEnabled: boolean;
  connection: CustomerGraphActionsConnectionDto | null;
}

type ConnectionWithHealth = CustomerGraphActionsConnectionSnapshot & { grantHealth?: GrantHealth };

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toConnectionDto(value: ConnectionWithHealth): CustomerGraphActionsConnectionDto {
  const health = value.grantHealth
    ?? deriveGrantHealth(value, profileManifest);
  return {
    id: value.id,
    tenantId: value.tenantId,
    clientId: value.clientId === '' ? null : value.clientId,
    displayName: value.displayName,
    status: value.status,
    grantHealth: health.state,
    manifestVersion: value.permissionManifestVersion,
    currentManifestVersion: profileManifest.version,
    observedGrants: [...health.observedGrants],
    missingGrants: [...health.missingGrants],
    unexpectedGrants: [...health.unexpectedGrants],
    grantsVerifiedAt: iso(value.grantsVerifiedAt),
    lastVerifiedAt: iso(value.lastVerifiedAt),
    lastErrorCode: value.lastErrorCode,
  };
}

function envelope(
  orgId: string,
  connection: ConnectionWithHealth | null,
): CustomerGraphActionsEnvelope {
  return {
    profile: {
      id: PROFILE_ID,
      displayName: PROFILE_DISPLAY_NAME,
      manifestVersion: profileManifest.version,
      requiredGrants: [...(profileManifest.applicationPermissionAssignments ?? [])],
    },
    onboardingEnabled: isM365CustomerGraphActionsOnboardingEnabledForOrg(orgId),
    connection: connection ? toConnectionDto(connection) : null,
  };
}

type ConcreteOrg = { orgId: string } | { status: 404; error: string };

function parseOrganizationQuery(c: Context): { orgId: string } | Response {
  const params = new URL(c.req.url).searchParams;
  const values = c.req.queries('orgId') ?? [];
  if (
    [...params.keys()].some((key) => key !== 'orgId')
    || values.length !== 1
    || !CANONICAL_ORG_ID.test(values[0] ?? '')
  ) {
    return c.json({ error: 'Invalid organization request' }, 400);
  }
  return { orgId: values[0]! };
}

function resolveConcreteOrg(auth: AuthContext, requestedOrgId: string): ConcreteOrg {
  if (auth.scope === 'organization') {
    if (!auth.orgId || requestedOrgId !== auth.orgId) {
      return { status: 404, error: 'Organization not found' };
    }
    return { orgId: auth.orgId };
  }

  if (!auth.canAccessOrg(requestedOrgId)) {
    return { status: 404, error: 'Organization not found' };
  }
  return { orgId: requestedOrgId };
}

function mutationOrg(c: Context): ConcreteOrg | Response {
  const auth = c.get('auth') as AuthContext;
  const parsed = parseOrganizationQuery(c);
  if (parsed instanceof Response) return parsed;
  const resolved = resolveConcreteOrg(auth, parsed.orgId);
  if (!('orgId' in resolved)) {
    return c.json(
      { error: resolved.status === 404 ? 'Connection not found' : resolved.error },
      resolved.status,
    );
  }
  if (auth.scope === 'partner' && !canManagePartnerWidePolicies(auth)) {
    return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
  }
  return resolved;
}

function lifecycleFailure(c: Context, error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : null;
  if (code === 'connection_not_found'
    || code === 'connection_not_executable'
    || code === 'stale_attempt'
    || code === 'tenant_already_bound') {
    return c.json({ error: 'Connection not found' }, 404);
  }
  return c.json({ error: 'Connection operation could not be completed' }, 409);
}

export const m365CustomerGraphActionsRoutes = new Hono();

m365CustomerGraphActionsRoutes.use('*', authMiddleware);

m365CustomerGraphActionsRoutes.get('/connections', requireOrgsRead, async (c) => {
  const parsed = parseOrganizationQuery(c);
  if (parsed instanceof Response) return parsed;
  const resolved = resolveConcreteOrg(c.get('auth'), parsed.orgId);
  if (!('orgId' in resolved)) return c.json({ error: resolved.error }, resolved.status);
  const connections = await listCustomerGraphActionsConnections(resolved.orgId);
  return c.json(envelope(resolved.orgId, connections[0] ?? null));
});

m365CustomerGraphActionsRoutes.post(
  '/connections/consent',
  requireOrgsWrite,
  requireMfa(),
  async (c) => {
    // Org-wide governance: Customer Graph Actions is the organization's WRITE
    // consent to its whole Entra tenant — granting, retesting or severing it
    // has no per-site slice to narrow a site-restricted caller to.
    // `organizations:write` + MFA are not enough (services/siteCeilingAccess.ts,
    // contract-site-ceiling-gate).
    if (!canMutateOrgWideGovernance(c.get('auth'))) {
      return c.json({ error: SITE_CEILING_WRITE_DENIED_MESSAGE }, 403);
    }
    const resolved = mutationOrg(c);
    if (resolved instanceof Response) return resolved;
    if (!('orgId' in resolved)) return c.json({ error: 'Connection not found' }, 404);
    // canAccessOrg is true for system scope: the holding org is never a target.
    if (await isHoldingOrg(resolved.orgId)) return c.json(PROTECTED_ORG_ERROR, 409);
    if (!isM365CustomerGraphActionsOnboardingEnabledForOrg(resolved.orgId)) {
      return c.json({ error: 'Customer Graph Actions onboarding is not enabled' }, 404);
    }
    try {
      const correlationId = randomUUID();
      const initiated = await initiateCustomerGraphActionsConsent({
        orgId: resolved.orgId,
        actorId: c.get('auth').user.id,
      });
      // Identity-first (#7910): the service returns the identity-phase
      // binding (tenant pinned for a bound row / upgrade, null for
      // /organizations); the route only signs it into the cookie.
      c.header('Set-Cookie', buildM365ActionsConsentBindingCookie(initiated.binding), { append: true });
      const auth = c.get('auth');
      recordM365CustomerGraphActionsEvent(c, {
        event: 'm365.customer_graph_actions.consent_initiated',
        orgId: resolved.orgId,
        connectionId: initiated.connection.id,
        profile: PROFILE_ID,
        consentAttemptId: initiated.connection.consentAttemptId,
        manifestVersion: profileManifest.version,
        outcome: 'initiated',
        correlationId,
        actorId: auth.user.id,
        actorEmail: auth.user.email,
      });
      // Key kept for the W2 web cards (they validate only the Microsoft host).
      return c.json({ adminConsentUrl: initiated.authorizationUrl });
    } catch (error) {
      return lifecycleFailure(c, error);
    }
  },
);

/**
 * Confirm-tenant interstitial (#7913 W03) — the actions twin of the read
 * routes (see m365CustomerGraphRead.ts for the full contract). Sets only the
 * actions binding cookie; the tenant only ever comes from the parked
 * server-side session.
 */
function confirmTenantGate(c: Context): { orgId: string } | Response {
  if (!canMutateOrgWideGovernance(c.get('auth'))) {
    return c.json({ error: SITE_CEILING_WRITE_DENIED_MESSAGE }, 403);
  }
  const resolved = mutationOrg(c);
  if (resolved instanceof Response) return resolved;
  if (!('orgId' in resolved)) return c.json({ error: 'Connection not found' }, 404);
  if (!isM365CustomerGraphActionsOnboardingEnabledForOrg(resolved.orgId)) {
    return c.json({ error: 'Connection not found' }, 404);
  }
  return resolved;
}

m365CustomerGraphActionsRoutes.get(
  '/connections/consent/pending',
  requireOrgsWrite,
  requireMfa(),
  async (c) => {
    const resolved = confirmTenantGate(c);
    if (resolved instanceof Response) return resolved;
    const pending = await readPendingCustomerGraphActionsTenantConfirmation({
      orgId: resolved.orgId,
      actorId: c.get('auth').user.id,
    });
    if (!pending) return c.json({ error: 'Connection not found' }, 404);
    return c.json({
      tenantId: pending.tenantId,
      administratorUsername: pending.administratorUsername,
      expiresAt: pending.expiresAt.toISOString(),
    });
  },
);

m365CustomerGraphActionsRoutes.post(
  '/connections/consent/continue',
  requireOrgsWrite,
  requireMfa(),
  async (c) => {
    const resolved = confirmTenantGate(c);
    if (resolved instanceof Response) return resolved;
    // canAccessOrg is true for system scope: the holding org is never a target.
    if (await isHoldingOrg(resolved.orgId)) return c.json(PROTECTED_ORG_ERROR, 409);
    const auth = c.get('auth');
    try {
      const continued = await continueCustomerGraphActionsConsent({
        orgId: resolved.orgId,
        actorId: auth.user.id,
      });
      c.header('Set-Cookie', buildM365ActionsConsentBindingCookie(continued.binding), { append: true });
      recordM365CustomerGraphActionsEvent(c, {
        event: 'm365.customer_graph_actions.tenant_confirmed',
        orgId: resolved.orgId,
        connectionId: continued.connection.id,
        profile: PROFILE_ID,
        consentAttemptId: continued.connection.consentAttemptId,
        manifestVersion: profileManifest.version,
        outcome: 'tenant_confirmed',
        correlationId: randomUUID(),
        verifiedTenantId: continued.verifiedTenantId,
        verifiedAdministratorObjectId: continued.verifiedAdministratorObjectId,
        actorId: auth.user.id,
        actorEmail: auth.user.email,
      });
      return c.json({ adminConsentUrl: continued.consentUrl });
    } catch (error) {
      return lifecycleFailure(c, error);
    }
  },
);

m365CustomerGraphActionsRoutes.post(
  '/connections/consent/cancel',
  requireOrgsWrite,
  requireMfa(),
  async (c) => {
    const resolved = confirmTenantGate(c);
    if (resolved instanceof Response) return resolved;
    const auth = c.get('auth');
    try {
      const connection = await cancelCustomerGraphActionsTenantConfirmation({
        orgId: resolved.orgId,
        actorId: auth.user.id,
      });
      recordM365CustomerGraphActionsEvent(c, {
        event: 'm365.customer_graph_actions.verification_failed',
        orgId: resolved.orgId,
        connectionId: connection.id,
        profile: PROFILE_ID,
        consentAttemptId: connection.consentAttemptId,
        manifestVersion: profileManifest.version,
        outcome: 'consent_cancelled',
        correlationId: randomUUID(),
        actorId: auth.user.id,
        actorEmail: auth.user.email,
      });
      return c.json({ connection: toConnectionDto(connection) });
    } catch (error) {
      return lifecycleFailure(c, error);
    }
  },
);

m365CustomerGraphActionsRoutes.post(
  '/connections/:id/retest',
  requireOrgsWrite,
  requireMfa(),
  zValidator('param', idParam),
  async (c) => {
    // Org-wide governance: Customer Graph Actions is the organization's WRITE
    // consent to its whole Entra tenant — granting, retesting or severing it
    // has no per-site slice to narrow a site-restricted caller to.
    // `organizations:write` + MFA are not enough (services/siteCeilingAccess.ts,
    // contract-site-ceiling-gate).
    if (!canMutateOrgWideGovernance(c.get('auth'))) {
      return c.json({ error: SITE_CEILING_WRITE_DENIED_MESSAGE }, 403);
    }
    const resolved = mutationOrg(c);
    if (resolved instanceof Response) return resolved;
    if (!('orgId' in resolved)) return c.json({ error: 'Connection not found' }, 404);
    const { id } = c.req.valid('param');
    try {
      const correlationId = randomUUID();
      const connection = await retestCustomerGraphActionsConnection({
        id,
        orgId: resolved.orgId,
        auth: c.get('auth'),
        correlationId,
      });
      const auth = c.get('auth');
      const outcome = connectionOutcome(connection);
      const eventInput = {
        orgId: resolved.orgId,
        connectionId: connection.id,
        profile: PROFILE_ID,
        consentAttemptId: connection.consentAttemptId,
        manifestVersion: connection.permissionManifestVersion,
        outcome,
        correlationId,
        actorId: auth.user.id,
        actorEmail: auth.user.email,
      } as const;
      recordM365CustomerGraphActionsEvent(c, {
        ...eventInput,
        event: 'm365.customer_graph_actions.retested',
      });
      if (GRANT_DRIFT_OUTCOMES.has(outcome)) {
        recordM365CustomerGraphActionsEvent(c, {
          ...eventInput,
          event: 'm365.customer_graph_actions.grant_drift_detected',
        });
      }
      return c.json({ connection: toConnectionDto(connection) });
    } catch (error) {
      return lifecycleFailure(c, error);
    }
  },
);

m365CustomerGraphActionsRoutes.post(
  '/connections/:id/disconnect',
  requireOrgsWrite,
  requireMfa(),
  zValidator('param', idParam),
  async (c) => {
    // Org-wide governance: Customer Graph Actions is the organization's WRITE
    // consent to its whole Entra tenant — granting, retesting or severing it
    // has no per-site slice to narrow a site-restricted caller to.
    // `organizations:write` + MFA are not enough (services/siteCeilingAccess.ts,
    // contract-site-ceiling-gate).
    if (!canMutateOrgWideGovernance(c.get('auth'))) {
      return c.json({ error: SITE_CEILING_WRITE_DENIED_MESSAGE }, 403);
    }
    const resolved = mutationOrg(c);
    if (resolved instanceof Response) return resolved;
    if (!('orgId' in resolved)) return c.json({ error: 'Connection not found' }, 404);
    const { id } = c.req.valid('param');
    try {
      const connection = await disconnectCustomerGraphActionsConnection({
        id,
        orgId: resolved.orgId,
        actorId: c.get('auth').user.id,
      });
      const auth = c.get('auth');
      recordM365CustomerGraphActionsEvent(c, {
        event: 'm365.customer_graph_actions.disconnected',
        orgId: resolved.orgId,
        connectionId: connection.id,
        profile: PROFILE_ID,
        consentAttemptId: connection.consentAttemptId,
        manifestVersion: connection.permissionManifestVersion,
        outcome: 'revoked',
        correlationId: randomUUID(),
        actorId: auth.user.id,
        actorEmail: auth.user.email,
      });
      return c.json({ connection: toConnectionDto(connection) });
    } catch (error) {
      return lifecycleFailure(c, error);
    }
  },
);
