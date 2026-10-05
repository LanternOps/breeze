/**
 * Helper Auth Middleware
 *
 * Authenticates Breeze Helper (tray) requests using the helper-scoped
 * bearer token (brz_ prefix). Extracted from routes/helper/index.ts for
 * reuse (e.g. extension /helper/* routes); behavior unchanged.
 */

import type { MiddlewareHandler } from 'hono';
import { createHash } from 'crypto';
import { eq, or } from 'drizzle-orm';
import { db, withSystemDbAccessContext, withDbAccessContext, type DbAccessContext } from '../db';
import { isSelfManagedDbContextRoute } from './selfManagedDbContextRoutes';
import { devices, organizations } from '../db/schema';
import type { AuthContext } from './auth';
import { matchAgentTokenHash } from './agentAuth';
import { evaluateDeviceCredentialLifecycle } from './deviceCredentialLifecycle';
import { PARKED_DEVICE_REFUSAL } from './agentAuthParked';
import { isUnassignedPoolOrgType } from '../services/unassignedPool/orgType';
import { buildHelperConfigUpdate } from '../services/helperSettings';

export interface HelperDevice {
  id: string;
  agentId: string;
  orgId: string;
  siteId: string;
  hostname: string;
  osType: string;
  osVersion: string;
  agentVersion: string;
}

declare module 'hono' {
  interface ContextVariableMap {
    helperDevice: HelperDevice;
    /** Effective Helper enabled setting for the device, resolved by helperAuth. */
    helperEnabled: boolean;
  }
}

/**
 * Answer for every helper route (core and extension /helper/*) when the
 * device's effective Helper setting is off. No route is exempt: no Helper
 * client polls a status route, and the agent stops and uninstalls the Helper
 * from the same setting on its next heartbeat. The code lets a client tell
 * this refusal apart from a credential failure.
 */
export const HELPER_DISABLED_REFUSAL = {
  error: 'Breeze Helper is disabled for this device by policy',
  code: 'helper_disabled',
} as const;

/**
 * Authenticate helper requests using the helper-scoped bearer token.
 * Similar to agentAuthMiddleware but sets helperDevice context
 * and creates a synthetic AuthContext for the streaming session manager.
 */
export const helperAuth: MiddlewareHandler = async (c, next) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid Authorization header' }, 401);
  }

  const token = authHeader.slice(7);
  if (!token.startsWith('brz_')) {
    return c.json({ error: 'Invalid agent token format' }, 401);
  }

  const tokenHash = createHash('sha256').update(token).digest('hex');

  const device = await withSystemDbAccessContext(async () => {
    const [row] = await db
      .select({
        id: devices.id,
        agentId: devices.agentId,
        orgId: devices.orgId,
        siteId: devices.siteId,
        hostname: devices.hostname,
        osType: devices.osType,
        osVersion: devices.osVersion,
        agentVersion: devices.agentVersion,
        helperTokenHash: devices.helperTokenHash,
        previousHelperTokenHash: devices.previousHelperTokenHash,
        previousHelperTokenExpiresAt: devices.previousHelperTokenExpiresAt,
        pendingHelperTokenHash: devices.pendingHelperTokenHash,
        pendingTokenExpiresAt: devices.pendingTokenExpiresAt,
        status: devices.status,
        agentTokenSuspendedAt: devices.agentTokenSuspendedAt,
        partnerId: organizations.partnerId,
        // Pre-assignment: a device parked in a holding org is refused below.
        organizationType: organizations.type,
      })
      .from(devices)
      .innerJoin(organizations, eq(organizations.id, devices.orgId))
      // Issue #2621 — the staged helper credential must be findable here too,
      // otherwise a helper holding the persisted-but-unconfirmed token 401s.
      .where(
        or(
          eq(devices.helperTokenHash, tokenHash),
          eq(devices.previousHelperTokenHash, tokenHash),
          eq(devices.pendingHelperTokenHash, tokenHash)
        )
      )
      .limit(1);
    return row ?? null;
  });

  const match = device
    ? matchAgentTokenHash({
        agentTokenHash: device.helperTokenHash,
        previousTokenHash: device.previousHelperTokenHash,
        previousTokenExpiresAt: device.previousHelperTokenExpiresAt,
        pendingTokenHash: device.pendingHelperTokenHash,
        pendingTokenExpiresAt: device.pendingTokenExpiresAt,
        tokenHash,
      })
    : null;

  if (!device || !match) {
    return c.json({ error: 'Invalid agent credentials' }, 401);
  }

  // Shared device-credential lifecycle gate (middleware/deviceCredentialLifecycle.ts)
  // — the same predicates the agent REST middleware and the WS upgrade run.
  // Helper sessions are NOT an uninstall-delivery path (no drain surface, and no
  // decommissioned exception), so `allowDraining: false`: only a fully active
  // tenant keeps an interactive AI/remote Helper session, mirroring the WS
  // upgrade's refusal of a draining tenant.
  const lifecycle = await evaluateDeviceCredentialLifecycle(device, { allowDraining: false });
  if (lifecycle.denied) {
    switch (lifecycle.reason) {
      case 'decommissioned':
        return c.json({ error: 'Device has been decommissioned' }, 403);
      case 'quarantined':
        return c.json({ error: 'Device is quarantined pending admin approval' }, 403);
      // A suspended token and an inactive/severed tenant both return the SAME
      // opaque 401 as a stale credential (mirrors agentAuth): the Helper must
      // not be able to distinguish suspension from a bad token.
      default:
        return c.json({ error: 'Invalid agent credentials' }, 401);
    }
  }

  // Pre-assignment: a device parked in its partner's
  // holding org keeps credential rotation and lifecycle removal on the agent
  // REST surface and nothing else. A Helper session is interactive AI, tool and
  // remote surface, so the helper token issued at enrollment is refused until
  // the device is assigned. Same body as the agent REST refusal.
  if (isUnassignedPoolOrgType(device.organizationType)) {
    return c.json(PARKED_DEVICE_REFUSAL, 403);
  }

  // Effective Helper enabled setting — the same resolver (and 120s cache) the
  // agent heartbeat uses to install/uninstall the Helper, so the two agree.
  // Resolved under a system context anchored to the authenticated device's own
  // org, exactly as the heartbeat does.
  let helperEnabled: boolean;
  try {
    const settings = await withSystemDbAccessContext(() => buildHelperConfigUpdate(device.id, device.orgId));
    helperEnabled = settings.enabled === true;
  } catch (err) {
    console.error('[helperAuth] failed to resolve effective helper settings:', err instanceof Error ? err.message : err);
    c.header('Retry-After', '30');
    return c.json({ error: 'Helper settings could not be loaded. Try again.' }, 503);
  }
  if (!helperEnabled) {
    return c.json(HELPER_DISABLED_REFUSAL, 403);
  }
  c.set('helperEnabled', helperEnabled);

  c.set('helperDevice', {
    id: device.id,
    agentId: device.agentId,
    orgId: device.orgId,
    siteId: device.siteId,
    hostname: device.hostname,
    osType: device.osType,
    osVersion: device.osVersion,
    agentVersion: device.agentVersion,
  });

  // Set a synthetic auth context for the streaming session manager
  // Helper sessions use a synthetic "device" user identity
  const syntheticAuth: AuthContext = {
    // A Helper desktop session: authenticated by device credential, not by a
    // human login. `user.id` is the DEVICE id, so this context never denotes
    // a person even though it occupies the user slot.
    principal: { kind: 'helper', deviceId: device.id },
    user: {
      id: device.id, // Use device ID as the "user" ID for helper sessions
      email: `helper@${device.hostname}`,
      name: device.hostname,
      isPlatformAdmin: false,
    },
    token: {
      sub: device.id,
      email: `helper@${device.hostname}`,
      roleId: null,
      type: 'access' as const,
      scope: 'organization' as const,
      orgId: device.orgId,
      partnerId: null,
      iat: Math.floor(Date.now() / 1000),
      mfa: false,
    },
    partnerId: null,
    orgId: device.orgId,
    scope: 'organization',
    accessibleOrgIds: [device.orgId],
    orgCondition: (orgIdColumn) => eq(orgIdColumn, device.orgId),
    canAccessOrg: (orgId) => orgId === device.orgId,
    helperDeviceId: device.id,
    helperDevicePartnerId: device.partnerId,
  };

  c.set('auth', syntheticAuth);

  // #3127 — the chat message-send route owns its DB context (it waits on a
  // blocked turn between two short ones; see selfManagedDbContextRoutes.ts), so
  // it must not inherit a request transaction held across that wait.
  if (isSelfManagedDbContextRoute(c.req.method, c.req.path)) {
    await next();
    return;
  }

  await withDbAccessContext(helperDbAccessContext(device), async () => {
    await next();
  });
};

/**
 * The org-scoped DB access context every helper request runs under. Exported so
 * a self-managed helper route re-enters exactly this context for each of its
 * short DB phases instead of re-deriving it by hand.
 */
export function helperDbAccessContext(
  device: { orgId: string; partnerId: string | null | undefined },
): DbAccessContext {
  return {
    scope: 'organization',
    orgId: device.orgId,
    accessibleOrgIds: [device.orgId],
    // Helper tokens have NO partner-AXIS access. This array gates
    // `breeze_has_partner_access`, which admits WRITES to partner-owned rows;
    // it stays empty, exactly as the agent sibling keeps it (agentAuth.ts) and
    // as the AuthContext design note requires (`helperDevicePartnerId` in
    // middleware/auth.ts: Helper tokens must never activate partner-wide RLS
    // branches). `currentPartnerId` below is a strictly separate, read-only
    // axis — do not merge the two. The partner-LLM BYOK read that needs the
    // partner runs under its own system context.
    accessiblePartnerIds: [],
    // Own partner — read-visibility of partner-wide catalog rows.
    currentPartnerId: device.partnerId ?? null,
  };
}
