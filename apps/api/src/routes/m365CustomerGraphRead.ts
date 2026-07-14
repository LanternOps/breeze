import {
  M365_PERMISSION_PROFILES,
  type CanonicalAppRoleAssignment,
  type M365ApplicationGrant,
} from '@breeze/shared/m365';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { zValidator } from '../lib/validation';
import {
  authMiddleware,
  requireMfa,
  requirePermission,
  type AuthContext,
} from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';
import {
  deriveGrantHealth,
  disconnectCustomerGraphReadConnection,
  initiateCustomerGraphReadConsent,
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

export interface CustomerGraphReadConnectionDto {
  id: string;
  tenantId: string | null;
  clientId: string;
  displayName: string | null;
  status: CustomerGraphReadConnectionSnapshot['status'];
  manifestVersion: number;
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
    manifestVersion: 2;
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
    clientId: value.clientId,
    displayName: value.displayName,
    status: value.status,
    manifestVersion: value.permissionManifestVersion,
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

type ConcreteOrg = { orgId: string } | { status: 400 | 404; error: string };

function resolveConcreteOrg(auth: AuthContext, requestedOrgId?: string): ConcreteOrg {
  if (auth.scope === 'organization') {
    if (!auth.orgId || (requestedOrgId && requestedOrgId !== auth.orgId)) {
      return { status: 404, error: 'Organization not found' };
    }
    return { orgId: auth.orgId };
  }

  if (requestedOrgId) {
    if (!auth.canAccessOrg(requestedOrgId)) {
      return { status: 404, error: 'Organization not found' };
    }
    return { orgId: requestedOrgId };
  }

  if (auth.orgId) return { orgId: auth.orgId };
  if (auth.accessibleOrgIds?.length === 1) return { orgId: auth.accessibleOrgIds[0]! };
  return { status: 400, error: 'A concrete organization is required' };
}

function mutationOrg(c: Context): ConcreteOrg | Response {
  const auth = c.get('auth') as AuthContext;
  const resolved = resolveConcreteOrg(auth, c.req.query('orgId'));
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

export const m365CustomerGraphReadRoutes = new Hono();

m365CustomerGraphReadRoutes.use('*', authMiddleware);

m365CustomerGraphReadRoutes.get('/connections', requireOrgsRead, async (c) => {
  const resolved = resolveConcreteOrg(c.get('auth'), c.req.query('orgId'));
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
    if (!isM365CustomerGraphReadOnboardingEnabledForOrg(resolved.orgId)) {
      return c.json({ error: 'Customer Graph Read onboarding is not enabled' }, 404);
    }
    try {
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
      writeRouteAudit(c, {
        orgId: resolved.orgId,
        action: 'm365.customer_graph_read.consent_initiated',
        resourceType: 'm365_connection',
        resourceId: initiated.connection.id,
        details: {
          profile: PROFILE_ID,
          consentAttemptId: initiated.connection.consentAttemptId,
        },
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
    const { id } = c.req.valid('param');
    try {
      const connection = await retestCustomerGraphReadConnection({
        id,
        orgId: resolved.orgId,
        auth: c.get('auth'),
      });
      writeRouteAudit(c, {
        orgId: resolved.orgId,
        action: 'm365.customer_graph_read.retested',
        resourceType: 'm365_connection',
        resourceId: connection.id,
        details: { profile: PROFILE_ID, status: connection.status },
      });
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
    const { id } = c.req.valid('param');
    try {
      const connection = await disconnectCustomerGraphReadConnection({
        id,
        orgId: resolved.orgId,
        actorId: c.get('auth').user.id,
      });
      writeRouteAudit(c, {
        orgId: resolved.orgId,
        action: 'm365.customer_graph_read.disconnected',
        resourceType: 'm365_connection',
        resourceId: connection.id,
        details: { profile: PROFILE_ID, status: connection.status },
      });
      return c.json({ connection: toConnectionDto(connection) });
    } catch (error) {
      return lifecycleFailure(c, error);
    }
  },
);
