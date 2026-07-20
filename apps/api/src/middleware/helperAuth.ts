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
import { db, withSystemDbAccessContext, withDbAccessContext } from '../db';
import { devices, organizations } from '../db/schema';
import type { AuthContext } from './auth';
import { matchAgentTokenHash } from './agentAuth';

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
  }
}

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
        status: devices.status,
        partnerId: organizations.partnerId,
      })
      .from(devices)
      .innerJoin(organizations, eq(organizations.id, devices.orgId))
      .where(or(eq(devices.helperTokenHash, tokenHash), eq(devices.previousHelperTokenHash, tokenHash)))
      .limit(1);
    return row ?? null;
  });

  const match = device
    ? matchAgentTokenHash({
        agentTokenHash: device.helperTokenHash,
        previousTokenHash: device.previousHelperTokenHash,
        previousTokenExpiresAt: device.previousHelperTokenExpiresAt,
        tokenHash,
      })
    : null;

  if (!device || !match) {
    return c.json({ error: 'Invalid agent credentials' }, 401);
  }

  if (device.status === 'decommissioned') {
    return c.json({ error: 'Device has been decommissioned' }, 403);
  }

  if (device.status === 'quarantined') {
    return c.json({ error: 'Device is quarantined pending admin approval' }, 403);
  }

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
  };

  c.set('auth', syntheticAuth);

  await withDbAccessContext(
    {
      scope: 'organization',
      orgId: device.orgId,
      accessibleOrgIds: [device.orgId],
      accessiblePartnerIds: [device.partnerId],
      // Own partner — read-visibility of partner-wide catalog rows.
      currentPartnerId: device.partnerId ?? null,
    },
    async () => {
      await next();
    },
  );
};
