import { and, eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import {
  devices,
  organizationUsers,
  partnerUsers,
  permissions,
  remoteSessions,
  rolePermissions,
  tunnelSessions,
  users,
} from '../db/schema';
import { checkRemoteAccess } from './remoteAccessPolicy';
import {
  consumeWsTicket,
  type ConsumeWsTicketResult,
} from './remoteSessionAuth';
import { getRedis } from './redis';
import { rateLimiter } from './rate-limit';
import {
  PERMISSIONS,
  type Permission,
} from './permissions';
import type {
  RemoteConnectionIdentity,
  RemoteWsKind,
} from './remoteWsOwnership';

const ACTIVE_SESSION_STATES = ['pending', 'connecting', 'active'];
const REMOTE_WS_RATE_LIMIT = 10;
const REMOTE_WS_RATE_WINDOW_SECONDS = 60;

export type RemoteWsAuthMode = 'post_upgrade' | 'pre_upgrade';

export interface ValidatedRemoteWsContext {
  sessionId: string;
  sessionType: RemoteWsKind;
  userId: string;
  orgId: string;
  siteId: string | null;
  deviceId: string;
  agentId: string;
  deviceHostname?: string;
  deviceOsType?: string;
  tunnelType?: 'vnc' | 'proxy';
  permission: {
    resource: typeof PERMISSIONS.REMOTE_ACCESS.resource;
    action: typeof PERMISSIONS.REMOTE_ACCESS.action;
  };
  ticketAssurance:
    | { kind: 'mfa_v2'; mfaSatisfied: true }
    | { kind: 'legacy_viewer_compatibility'; mfaSatisfied?: never }
    | { kind: 'legacy_unversioned_v0'; mfaSatisfied?: never };
  ticketJti: string | null;
  connection: RemoteConnectionIdentity;
}

export interface ConsumedRemoteWsTicketContext {
  sessionId: string;
  sessionType: RemoteWsKind;
  userId: string;
  ticketAssurance: ValidatedRemoteWsContext['ticketAssurance'];
  ticketJti: string | null;
}

export type RemoteWsTicketIntakeResult =
  | { ok: true; ticket: ConsumedRemoteWsTicketContext }
  | {
      ok: false;
      status: 401 | 403 | 503;
      reason:
        | 'ticket_missing'
        | 'ticket_invalid'
        | 'ticket_mismatch'
        | 'ticket_version_not_allowed'
        | 'mfa_unassured'
        | 'authorization_unavailable';
    };

export type RemoteWsAuthorizationResult =
  | { ok: true; context: Omit<ValidatedRemoteWsContext, 'connection'> }
  | {
      ok: false;
      status: 403 | 404 | 429 | 503;
      reason:
        | 'user_inactive'
        | 'session_missing'
        | 'session_inactive'
        | 'session_not_owned'
        | 'site_denied'
        | 'permission_denied'
        | 'device_offline'
        | 'policy_denied'
        | 'rate_limited'
        | 'authorization_unavailable';
    };

function ticketAssurance(
  result: Extract<ConsumeWsTicketResult, { ok: true }>,
  mode: RemoteWsAuthMode,
): RemoteWsTicketIntakeResult {
  const base = {
    sessionId: result.sessionId,
    sessionType: result.sessionType as RemoteWsKind,
    userId: result.userId,
  };
  if (result.version === 2) {
    if (result.mfaSatisfied !== true) {
      return { ok: false, status: 403, reason: 'mfa_unassured' };
    }
    return {
      ok: true,
      ticket: {
        ...base,
        ticketAssurance: { kind: 'mfa_v2', mfaSatisfied: true },
        ticketJti: result.ticketJti,
      },
    };
  }
  if (result.version === 1) {
    if (mode !== 'post_upgrade') {
      return { ok: false, status: 403, reason: 'ticket_version_not_allowed' };
    }
    return {
      ok: true,
      ticket: {
        ...base,
        ticketAssurance: { kind: 'legacy_viewer_compatibility' },
        ticketJti: result.ticketJti,
      },
    };
  }
  if (mode !== 'post_upgrade') {
    return { ok: false, status: 403, reason: 'ticket_version_not_allowed' };
  }
  return {
    ok: true,
    ticket: {
      ...base,
      ticketAssurance: { kind: 'legacy_unversioned_v0' },
      ticketJti: null,
    },
  };
}

export async function consumeRemoteWsUpgradeTicket(input: {
  sessionId: string;
  expectedType: RemoteWsKind;
  ticket: string | undefined;
  mode: RemoteWsAuthMode;
  caller: { ip: string; userAgent: string };
}): Promise<RemoteWsTicketIntakeResult> {
  if (!input.ticket) {
    return { ok: false, status: 401, reason: 'ticket_missing' };
  }

  let consumed: ConsumeWsTicketResult;
  try {
    consumed = await consumeWsTicket(input.ticket, input.caller);
  } catch {
    return { ok: false, status: 503, reason: 'authorization_unavailable' };
  }
  if (!consumed.ok) {
    return { ok: false, status: 401, reason: 'ticket_invalid' };
  }
  if (
    consumed.sessionId !== input.sessionId
    || consumed.sessionType !== input.expectedType
  ) {
    return { ok: false, status: 401, reason: 'ticket_mismatch' };
  }

  return ticketAssurance(consumed, input.mode);
}

function hasRemoteAccessPermission(grants: Permission[]): boolean {
  return grants.some((grant) => (
    (grant.resource === PERMISSIONS.REMOTE_ACCESS.resource || grant.resource === '*')
    && (grant.action === PERMISSIONS.REMOTE_ACCESS.action || grant.action === '*')
  ));
}

function partnerCanAccessOrg(
  membership: {
    orgAccess: 'all' | 'selected' | 'none';
    orgIds: string[] | null;
  },
  orgId: string,
): boolean {
  if (membership.orgAccess === 'all') return true;
  if (membership.orgAccess === 'selected') {
    return membership.orgIds?.includes(orgId) ?? false;
  }
  return false;
}

export async function authorizeConsumedRemoteWsTicket(
  consumed: ConsumedRemoteWsTicketContext,
): Promise<RemoteWsAuthorizationResult> {
  try {
    const live = await withSystemDbAccessContext(async () => {
      const [user] = await db
        .select({
          id: users.id,
          status: users.status,
          partnerId: users.partnerId,
        })
        .from(users)
        .where(eq(users.id, consumed.userId))
        .limit(1);
      if (!user || user.status !== 'active') {
        return { denied: 'user_inactive' as const };
      }

      const sessionRows = consumed.sessionType === 'tunnel'
        ? await db
            .select({ session: tunnelSessions, device: devices })
            .from(tunnelSessions)
            .innerJoin(devices, and(
              eq(tunnelSessions.deviceId, devices.id),
              eq(tunnelSessions.orgId, devices.orgId),
            ))
            .where(eq(tunnelSessions.id, consumed.sessionId))
            .limit(1)
        : await db
            .select({ session: remoteSessions, device: devices })
            .from(remoteSessions)
            .innerJoin(devices, and(
              eq(remoteSessions.deviceId, devices.id),
              eq(remoteSessions.orgId, devices.orgId),
            ))
            .where(eq(remoteSessions.id, consumed.sessionId))
            .limit(1);
      const joined = sessionRows[0];
      if (!joined) return { denied: 'session_missing' as const };
      if (joined.session.orgId !== joined.device.orgId) {
        return { denied: 'session_not_owned' as const };
      }

      const expectedDatabaseType = consumed.sessionType === 'tunnel'
        ? null
        : consumed.sessionType;
      if (expectedDatabaseType !== null && joined.session.type !== expectedDatabaseType) {
        return { denied: 'session_missing' as const };
      }
      if (joined.session.userId !== user.id) {
        return { denied: 'session_not_owned' as const };
      }
      if (!ACTIVE_SESSION_STATES.includes(joined.session.status)) {
        return { denied: 'session_inactive' as const };
      }
      if (joined.device.status !== 'online') {
        return { denied: 'device_offline' as const };
      }

      const [orgMembershipRows, partnerMembershipRows] = await Promise.all([
        db
          .select({
            roleId: organizationUsers.roleId,
            siteIds: organizationUsers.siteIds,
          })
          .from(organizationUsers)
          .where(and(
            eq(organizationUsers.userId, user.id),
            eq(organizationUsers.orgId, joined.session.orgId),
          ))
          .limit(1),
        db
          .select({
            roleId: partnerUsers.roleId,
            orgAccess: partnerUsers.orgAccess,
            orgIds: partnerUsers.orgIds,
          })
          .from(partnerUsers)
          .where(and(
            eq(partnerUsers.userId, user.id),
            eq(partnerUsers.partnerId, user.partnerId),
          ))
          .limit(1),
      ]);

      const orgMembership = orgMembershipRows[0];
      const partnerMembership = partnerMembershipRows[0];
      let roleId: string | null = null;
      if (orgMembership?.roleId) {
        roleId = orgMembership.roleId;
        if (
          orgMembership.siteIds !== null
          && !orgMembership.siteIds.includes(joined.device.siteId)
        ) {
          return { denied: 'site_denied' as const };
        }
      } else if (
        partnerMembership?.roleId
        && partnerCanAccessOrg(partnerMembership, joined.session.orgId)
      ) {
        roleId = partnerMembership.roleId;
      } else {
        return { denied: 'session_not_owned' as const };
      }

      const grants = await db
        .select({
          resource: permissions.resource,
          action: permissions.action,
        })
        .from(rolePermissions)
        .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
        .where(eq(rolePermissions.roleId, roleId));
      if (!hasRemoteAccessPermission(grants)) {
        return { denied: 'permission_denied' as const };
      }

      const capability = consumed.sessionType === 'terminal'
        ? 'remoteTools'
        : consumed.sessionType === 'desktop'
          ? 'webrtcDesktop'
          : joined.session.type === 'vnc'
            ? 'vncRelay'
            : 'proxy';
      const policy = await checkRemoteAccess(joined.device.id, capability);
      if (!policy.allowed) {
        return { denied: 'policy_denied' as const };
      }

      return {
        user,
        session: joined.session,
        device: joined.device,
      };
    });

    if ('denied' in live && live.denied !== undefined) {
      const status = live.denied === 'session_missing'
        ? 404
        : live.denied === 'device_offline'
          ? 503
          : 403;
      return { ok: false, status, reason: live.denied };
    }

    const limit = await rateLimiter(
      getRedis(),
      `${consumed.sessionType}ws:conn:${live.user.id}`,
      REMOTE_WS_RATE_LIMIT,
      REMOTE_WS_RATE_WINDOW_SECONDS,
    );
    if (!limit.allowed) {
      return { ok: false, status: 429, reason: 'rate_limited' };
    }

    return {
      ok: true,
      context: {
        sessionId: consumed.sessionId,
        sessionType: consumed.sessionType,
        userId: consumed.userId,
        orgId: live.session.orgId,
        siteId: live.device.siteId ?? null,
        deviceId: live.device.id,
        agentId: live.device.agentId,
        deviceHostname: live.device.hostname,
        deviceOsType: live.device.osType,
        ...(consumed.sessionType === 'tunnel'
          ? { tunnelType: live.session.type as 'vnc' | 'proxy' }
          : {}),
        permission: PERMISSIONS.REMOTE_ACCESS,
        ticketAssurance: consumed.ticketAssurance,
        ticketJti: consumed.ticketJti,
      },
    };
  } catch {
    return { ok: false, status: 503, reason: 'authorization_unavailable' };
  }
}
