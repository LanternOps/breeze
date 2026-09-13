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
  disconnectCustomerGraphReadConnection,
  initiateCustomerGraphReadConsent,
  initiateCustomerGraphReadUpgradeConsent,
  listCustomerGraphReadConnections,
  retestCustomerGraphReadConnection,
  type CustomerGraphReadConnectionSnapshot,
  type GrantHealth,
} from '../services/m365ControlPlane/connectionService';
import { buildM365ConsentBindingCookie } from '../services/m365ControlPlane/browserBinding';
import { isM365CustomerGraphReadOnboardingEnabledForOrg } from '../services/m365ControlPlane/runtimeConfig';
import {
  canManagePartnerWidePolicies,
  PARTNER_WIDE_WRITE_DENIED_MESSAGE,
} from '../services/partnerWideAccess';
import { PERMISSIONS } from '../services/permissions';
import {
  M365_CUSTOMER_GRAPH_READ_OUTCOMES,
  recordM365CustomerGraphReadEvent,
  type M365CustomerGraphReadOutcome,
} from '../services/m365ControlPlane/metrics';

const PROFILE_ID = 'customer-graph-read' as const;
const PROFILE_DISPLAY_NAME = 'Customer Graph Read';
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
const SAFE_OUTCOMES = new Set<string>(M365_CUSTOMER_GRAPH_READ_OUTCOMES);
const GRANT_DRIFT_OUTCOMES = new Set<M365CustomerGraphReadOutcome>([
  'grant_missing', 'grant_unexpected', 'manifest_stale',
]);

function connectionOutcome(
  value: CustomerGraphReadConnectionSnapshot,
): M365CustomerGraphReadOutcome {
  if (value.status === 'active') return 'active';
  if (value.status === 'revoked') return 'revoked';
  if (value.lastErrorCode && SAFE_OUTCOMES.has(value.lastErrorCode)) {
    return value.lastErrorCode as M365CustomerGraphReadOutcome;
  }
  if (value.status === 'degraded') return 'degraded';
  return 'executor_unavailable';
}

export interface CustomerGraphReadConnectionDto {
  id: string;
  tenantId: string | null;
  clientId: string | null;
  displayName: string | null;
  status: CustomerGraphReadConnectionSnapshot['status'];
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

export interface CustomerGraphReadEnvelope {
  profile: {
    id: typeof PROFILE_ID;
    displayName: string;
    // Was a hard-coded literal, which stops compiling the moment the manifest
    // moves. The manifest is the single source; the DTO reports it.
    manifestVersion: number;
    requiredGrants: M365ApplicationGrant[];
  };
  onboardingEnabled: boolean;
  connection: CustomerGraphReadConnectionDto | null;
}

type ConnectionWithHealth = CustomerGraphReadConnectionSnapshot & { grantHealth?: GrantHealth };

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toConnectionDto(value: ConnectionWithHealth): CustomerGraphReadConnectionDto {
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
): CustomerGraphReadEnvelope {
  return {
    profile: {
      id: PROFILE_ID,
      displayName: PROFILE_DISPLAY_NAME,
      manifestVersion: profileManifest.version,
      requiredGrants: [...(profileManifest.applicationPermissionAssignments ?? [])],
    },
    onboardingEnabled: isM365CustomerGraphReadOnboardingEnabledForOrg(orgId),
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
  if (code === 'manifest_current') {
    // Reachable by racing the banner (two tabs, double click). Saying so beats
    // the generic message, because the correct next step is "reload", not
    // "retry".
    return c.json({ error: 'The connection already uses the current permission manifest' }, 409);
  }
  return c.json({ error: 'Connection operation could not be completed' }, 409);
}

export const m365CustomerGraphReadRoutes = new Hono();

m365CustomerGraphReadRoutes.use('*', authMiddleware);

m365CustomerGraphReadRoutes.get('/connections', requireOrgsRead, async (c) => {
  const parsed = parseOrganizationQuery(c);
  if (parsed instanceof Response) return parsed;
  const resolved = resolveConcreteOrg(c.get('auth'), parsed.orgId);
  if (!('orgId' in resolved)) return c.json({ error: resolved.error }, resolved.status);
  const connections = await listCustomerGraphReadConnections(resolved.orgId);
  return c.json(envelope(resolved.orgId, connections[0] ?? null));
});

m365CustomerGraphReadRoutes.post(
  '/connections/customer-graph-read/consent',
  requireOrgsWrite,
  requireMfa(),
  async (c) => {
    const resolved = mutationOrg(c);
    if (resolved instanceof Response) return resolved;
    if (!('orgId' in resolved)) return c.json({ error: 'Connection not found' }, 404);
    if (!isM365CustomerGraphReadOnboardingEnabledForOrg(resolved.orgId)) {
      return c.json({ error: 'Customer Graph Read onboarding is not enabled' }, 404);
    }
    try {
      const correlationId = randomUUID();
      const initiated = await initiateCustomerGraphReadConsent({
        orgId: resolved.orgId,
        actorId: c.get('auth').user.id,
      });
      c.header('Set-Cookie', buildM365ConsentBindingCookie({
        phase: 'admin_consent',
        rawState: initiated.rawState,
        connectionId: initiated.connection.id,
        consentAttemptId: initiated.connection.consentAttemptId,
        tenantHint: null,
      }), { append: true });
      const auth = c.get('auth');
      recordM365CustomerGraphReadEvent(c, {
        event: 'm365.customer_graph_read.consent_initiated',
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
      return c.json({ adminConsentUrl: initiated.consentUrl });
    } catch (error) {
      return lifecycleFailure(c, error);
    }
  },
);

/**
 * Starts a manifest upgrade on an existing connection (spec §2.2). Unlike the
 * consent route above, this one does not move the connection to
 * pending-consent — reads keep working on the grants the customer already
 * approved for the whole duration of the Microsoft round trip, including if
 * the administrator abandons it.
 */
m365CustomerGraphReadRoutes.post(
  '/connections/:id/upgrade-consent',
  requireOrgsWrite,
  requireMfa(),
  zValidator('param', idParam),
  async (c) => {
    const resolved = mutationOrg(c);
    if (resolved instanceof Response) return resolved;
    if (!('orgId' in resolved)) return c.json({ error: 'Connection not found' }, 404);
    const { id } = c.req.valid('param');
    try {
      const correlationId = randomUUID();
      const initiated = await initiateCustomerGraphReadUpgradeConsent({
        connectionId: id,
        orgId: resolved.orgId,
        auth: c.get('auth'),
      });
      c.header('Set-Cookie', buildM365ConsentBindingCookie({
        phase: 'admin_consent',
        rawState: initiated.rawState,
        connectionId: initiated.connection.id,
        consentAttemptId: initiated.connection.consentAttemptId,
        tenantHint: null,
      }), { append: true });
      const auth = c.get('auth');
      recordM365CustomerGraphReadEvent(c, {
        event: 'm365.customer_graph_read.upgrade_consent_initiated',
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
      return c.json({ adminConsentUrl: initiated.consentUrl });
    } catch (error) {
      return lifecycleFailure(c, error);
    }
  },
);

m365CustomerGraphReadRoutes.post(
  '/connections/:id/retest',
  requireOrgsWrite,
  requireMfa(),
  zValidator('param', idParam),
  async (c) => {
    const resolved = mutationOrg(c);
    if (resolved instanceof Response) return resolved;
    if (!('orgId' in resolved)) return c.json({ error: 'Connection not found' }, 404);
    const { id } = c.req.valid('param');
    try {
      const correlationId = randomUUID();
      const connection = await retestCustomerGraphReadConnection({
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
      recordM365CustomerGraphReadEvent(c, {
        ...eventInput,
        event: 'm365.customer_graph_read.retested',
      });
      if (GRANT_DRIFT_OUTCOMES.has(outcome)) {
        recordM365CustomerGraphReadEvent(c, {
          ...eventInput,
          event: 'm365.customer_graph_read.grant_drift_detected',
        });
      }
      return c.json({ connection: toConnectionDto(connection) });
    } catch (error) {
      return lifecycleFailure(c, error);
    }
  },
);

m365CustomerGraphReadRoutes.post(
  '/connections/:id/disconnect',
  requireOrgsWrite,
  requireMfa(),
  zValidator('param', idParam),
  async (c) => {
    const resolved = mutationOrg(c);
    if (resolved instanceof Response) return resolved;
    if (!('orgId' in resolved)) return c.json({ error: 'Connection not found' }, 404);
    const { id } = c.req.valid('param');
    try {
      const connection = await disconnectCustomerGraphReadConnection({
        id,
        orgId: resolved.orgId,
        actorId: c.get('auth').user.id,
      });
      const auth = c.get('auth');
      recordM365CustomerGraphReadEvent(c, {
        event: 'm365.customer_graph_read.disconnected',
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
