import { and, eq, sql, inArray, lte, or } from 'drizzle-orm';
import { createHmac } from 'crypto';
import { db } from '../../db';
import {
  remoteSessions,
  fileTransfers,
  devices,
  auditLogs
} from '../../db/schema';

// ============================================
// TURN CREDENTIAL GENERATION (RFC 5389 time-limited HMAC)
// ============================================

export function generateTurnCredentials(): { username: string; credential: string } | null {
  const secret = process.env.TURN_SECRET;
  if (!secret) return null;

  const ttl = 86400; // 24 hours
  const expiry = Math.floor(Date.now() / 1000) + ttl;
  const username = `${expiry}:breeze`;
  // TURN credential generation commonly uses HMAC-SHA1 with a shared secret on the TURN server.
  // This is not used for password storage or encryption; if your TURN server supports HMAC-SHA256,
  // prefer switching to it on both ends.
  // lgtm[js/weak-cryptographic-algorithm]
  const credential = createHmac('sha1', secret).update(username).digest('base64');

  return { username, credential };
}

export function getIceServers(): Array<{ urls: string | string[]; username?: string; credential?: string }> {
  const servers: Array<{ urls: string | string[]; username?: string; credential?: string }> = [
    { urls: 'stun:stun.l.google.com:19302' }
  ];

  const turnHost = process.env.TURN_HOST;
  const turnPort = process.env.TURN_PORT || '3478';

  if (turnHost) {
    const creds = generateTurnCredentials();
    if (creds) {
      servers.push({
        urls: [
          `turn:${turnHost}:${turnPort}?transport=udp`,
          `turn:${turnHost}:${turnPort}?transport=tcp`
        ],
        username: creds.username,
        credential: creds.credential
      });
    }
  }

  return servers;
}

// ============================================
// HELPER FUNCTIONS
// ============================================

export { getPagination } from '../../utils/pagination';

export function envInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

export const MAX_ACTIVE_TRANSFERS_PER_ORG = envInt('MAX_ACTIVE_TRANSFERS_PER_ORG', 20);
export const MAX_ACTIVE_TRANSFERS_PER_USER = envInt('MAX_ACTIVE_TRANSFERS_PER_USER', 10);
export const MAX_ACTIVE_REMOTE_SESSIONS_PER_ORG = envInt('MAX_ACTIVE_REMOTE_SESSIONS_PER_ORG', 10);
export const MAX_ACTIVE_REMOTE_SESSIONS_PER_USER = envInt('MAX_ACTIVE_REMOTE_SESSIONS_PER_USER', 5);

export function hasSessionOrTransferOwnership(
  auth: { scope: string; user: { id: string } },
  ownerUserId: string
) {
  if (auth.scope === 'system') {
    return true;
  }
  return auth.user.id === ownerUserId;
}

export function ensureOrgAccess(orgId: string, auth: { canAccessOrg: (orgId: string) => boolean }) {
  return auth.canAccessOrg(orgId);
}

export async function getDeviceWithOrgCheck(deviceId: string, auth: { canAccessOrg: (orgId: string) => boolean }) {
  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) {
    return null;
  }

  const hasAccess = ensureOrgAccess(device.orgId, auth);
  if (!hasAccess) {
    return null;
  }

  return device;
}

export async function getSessionWithOrgCheck(sessionId: string, auth: { canAccessOrg: (orgId: string) => boolean }) {
  const [session] = await db
    .select({
      session: remoteSessions,
      device: devices
    })
    .from(remoteSessions)
    .innerJoin(devices, eq(remoteSessions.deviceId, devices.id))
    .where(eq(remoteSessions.id, sessionId))
    .limit(1);

  if (!session) {
    return null;
  }

  const hasAccess = ensureOrgAccess(session.device.orgId, auth);
  if (!hasAccess) {
    return null;
  }

  return session;
}

export async function getTransferWithOrgCheck(transferId: string, auth: { canAccessOrg: (orgId: string) => boolean }) {
  const [transfer] = await db
    .select({
      transfer: fileTransfers,
      device: devices
    })
    .from(fileTransfers)
    .innerJoin(devices, eq(fileTransfers.deviceId, devices.id))
    .where(eq(fileTransfers.id, transferId))
    .limit(1);

  if (!transfer) {
    return null;
  }

  const hasAccess = ensureOrgAccess(transfer.device.orgId, auth);
  if (!hasAccess) {
    return null;
  }

  return transfer;
}

// Auto-expire stale sessions that were never properly connected
export async function expireStaleSessions(orgId: string) {
  const now = new Date();
  // Pending sessions older than 5 minutes were never picked up
  const pendingCutoff = new Date(now.getTime() - 5 * 60 * 1000);
  // Connecting sessions older than 2 minutes failed to negotiate
  const connectingCutoff = new Date(now.getTime() - 2 * 60 * 1000);

  await db
    .update(remoteSessions)
    .set({ status: 'disconnected', endedAt: now })
    .where(
      and(
        inArray(remoteSessions.deviceId,
          db.select({ id: devices.id }).from(devices).where(eq(devices.orgId, orgId))
        ),
        or(
          and(eq(remoteSessions.status, 'pending'), lte(remoteSessions.createdAt, pendingCutoff)),
          and(eq(remoteSessions.status, 'connecting'), lte(remoteSessions.createdAt, connectingCutoff))
        )
      )
    );
}

export async function expireStaleSessionsForUser(userId: string) {
  const now = new Date();
  const pendingCutoff = new Date(now.getTime() - 5 * 60 * 1000);
  const connectingCutoff = new Date(now.getTime() - 2 * 60 * 1000);

  await db
    .update(remoteSessions)
    .set({ status: 'disconnected', endedAt: now })
    .where(
      and(
        eq(remoteSessions.userId, userId),
        or(
          and(eq(remoteSessions.status, 'pending'), lte(remoteSessions.createdAt, pendingCutoff)),
          and(eq(remoteSessions.status, 'connecting'), lte(remoteSessions.createdAt, connectingCutoff))
        )
      )
    );
}

// Rate limiting helper - check concurrent sessions per org
export async function checkSessionRateLimit(orgId: string, maxConcurrent: number = MAX_ACTIVE_REMOTE_SESSIONS_PER_ORG): Promise<{ allowed: boolean; currentCount: number }> {
  if (maxConcurrent <= 0) {
    return { allowed: true, currentCount: 0 };
  }

  // Clean up stale sessions first so they don't count against the limit
  await expireStaleSessions(orgId);

  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(remoteSessions)
    .innerJoin(devices, eq(remoteSessions.deviceId, devices.id))
    .where(
      and(
        eq(devices.orgId, orgId),
        inArray(remoteSessions.status, ['pending', 'connecting', 'active'])
      )
    );

  const currentCount = Number(countResult[0]?.count ?? 0);
  return {
    allowed: currentCount < maxConcurrent,
    currentCount
  };
}

export async function checkUserSessionRateLimit(userId: string, maxConcurrent: number = MAX_ACTIVE_REMOTE_SESSIONS_PER_USER): Promise<{ allowed: boolean; currentCount: number }> {
  if (maxConcurrent <= 0) {
    return { allowed: true, currentCount: 0 };
  }

  await expireStaleSessionsForUser(userId);

  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(remoteSessions)
    .where(
      and(
        eq(remoteSessions.userId, userId),
        inArray(remoteSessions.status, ['pending', 'connecting', 'active'])
      )
    );

  const currentCount = Number(countResult[0]?.count ?? 0);
  return {
    allowed: currentCount < maxConcurrent,
    currentCount
  };
}

// Log audit event for session activity
export async function logSessionAudit(
  action: string,
  actorId: string,
  orgId: string,
  details: Record<string, unknown>,
  ipAddress?: string
) {
  try {
    await db.insert(auditLogs).values({
      orgId,
      actorType: 'user',
      actorId,
      action,
      resourceType: 'remote_session',
      resourceId: details.sessionId as string,
      details,
      ipAddress,
      result: 'success'
    });
  } catch (error) {
    console.error('Failed to log session audit:', error);
  }
}
