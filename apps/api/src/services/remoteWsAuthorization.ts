import { and, eq, isNull } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import {
  devices,
  organizationUsers,
  organizations,
  partners,
  partnerUsers,
  permissions,
  remoteSessions,
  rolePermissions,
  tunnelSessions,
  users,
} from '../db/schema';
import { checkRemoteAccess } from './remoteAccessPolicy';
import { partnerTrustMode } from '../config/partnerTrustMode';
import { evaluateCapabilityContinuationForState } from './partnerTrust';
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
import { tightenStatementTimeout } from '../db/lockTimeout';

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
        | 'partner_trust_denied'
        | 'rate_limited'
        | 'authorization_unavailable';
    };

export type RemoteWsLiveAuthorizationResult =
  | { ok: true }
  | {
      ok: false;
      status: 403 | 404 | 503;
      reason: Exclude<Extract<RemoteWsAuthorizationResult, { ok: false }>['reason'], 'rate_limited'>;
    };

export type LiveRemoteSessionAuthorizationResult =
  | {
      ok: true;
      user: Pick<typeof users.$inferSelect, 'id' | 'email' | 'status' | 'partnerId'>;
      session: typeof remoteSessions.$inferSelect | typeof tunnelSessions.$inferSelect;
      device: typeof devices.$inferSelect;
    }
  | Exclude<RemoteWsAuthorizationResult, { ok: true }>;

export const REMOTE_WS_LIVE_AUTHORIZATION_TIMEOUT_MS = 2_000;

export type RemoteSessionContinuationResult =
  | {
      ok: true;
      context: Omit<ValidatedRemoteWsContext, 'connection' | 'ticketAssurance' | 'ticketJti'>;
    }
  | Exclude<RemoteWsAuthorizationResult, { ok: true }>;

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

function hasPermission(grants: Permission[], required: Permission): boolean {
  return grants.some((grant) => (
    (grant.resource === required.resource || grant.resource === '*')
    && (grant.action === required.action || grant.action === '*')
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

async function resolveRemoteWsLiveAuthority(
  consumed: Pick<ConsumedRemoteWsTicketContext, 'sessionId' | 'sessionType' | 'userId'>,
  bypassPolicyCache: boolean,
  statementTimeoutMs?: number,
  requiredPermissions: Permission[] = [PERMISSIONS.REMOTE_ACCESS],
  accessMode: 'live' | 'failure-diagnostics' = 'live',
) {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    if (statementTimeoutMs !== undefined) {
      await tightenStatementTimeout(db, statementTimeoutMs);
    }
    const [user] = await db
      .select({ id: users.id, email: users.email, status: users.status, partnerId: users.partnerId })
      .from(users).where(eq(users.id, consumed.userId)).limit(1);
    if (!user || user.status !== 'active') return { denied: 'user_inactive' as const };

    const sessionRows = consumed.sessionType === 'tunnel'
      ? await db.select({ session: tunnelSessions, device: devices }).from(tunnelSessions)
          .innerJoin(devices, and(eq(tunnelSessions.deviceId, devices.id), eq(tunnelSessions.orgId, devices.orgId)))
          .where(eq(tunnelSessions.id, consumed.sessionId)).limit(1)
      : await db.select({
          session: remoteSessions,
          device: devices,
          partner: {
            id: partners.id,
            trustState: partners.trustState,
            probationEnrollments: partners.probationEnrollments,
          },
        }).from(remoteSessions)
          .innerJoin(devices, and(eq(remoteSessions.deviceId, devices.id), eq(remoteSessions.orgId, devices.orgId)))
          .innerJoin(organizations, eq(devices.orgId, organizations.id))
          .innerJoin(partners, eq(organizations.partnerId, partners.id))
          .where(eq(remoteSessions.id, consumed.sessionId)).limit(1);
    const joined = sessionRows[0];
    if (!joined) return { denied: 'session_missing' as const };
    if (joined.session.orgId !== joined.device.orgId) return { denied: 'session_not_owned' as const };
    const expectedDatabaseType = consumed.sessionType === 'tunnel' ? null : consumed.sessionType;
    if (expectedDatabaseType !== null && joined.session.type !== expectedDatabaseType) return { denied: 'session_missing' as const };
    if (joined.session.userId !== user.id) return { denied: 'session_not_owned' as const };
    // Preserve the viewer's read-only failure status exception. All lifecycle,
    // membership/site, role and policy checks below still apply; callers that
    // can mint credentials, signal or relay always use the default live mode.
    const readingFailure = accessMode === 'failure-diagnostics' &&
      consumed.sessionType === 'desktop' &&
      (joined.session.status === 'failed' ||
        (joined.session.status === 'disconnected' && !!joined.session.errorMessage));
    if (!ACTIVE_SESSION_STATES.includes(joined.session.status) && !readingFailure) return { denied: 'session_inactive' as const };
    if (joined.device.status !== 'online' && !readingFailure) return { denied: 'device_offline' as const };

    const [organization] = await db
      .select({
        id: organizations.id,
        partnerId: organizations.partnerId,
        status: organizations.status,
        deletedAt: organizations.deletedAt,
      })
      .from(organizations)
      .where(eq(organizations.id, joined.session.orgId))
      .limit(1);
    if (
      !organization
      || organization.deletedAt !== null
      || !['active', 'trial'].includes(organization.status)
    ) {
      return { denied: 'session_not_owned' as const };
    }

    // Organization usability is subordinate to its owning partner. Match
    // getActiveOrgTenant's strict lifecycle contract: suspended, churned or
    // soft-deleted partners cannot retain remote-session authority through
    // an otherwise active organization. Key this lookup from the live
    // organization row so a stale user/token partner claim cannot select a
    // different tenant owner.
    const [owningPartner] = await db
      .select({
        id: partners.id,
        status: partners.status,
        deletedAt: partners.deletedAt,
      })
      .from(partners)
      .where(and(
        eq(partners.id, organization.partnerId),
        isNull(partners.deletedAt),
      ))
      .limit(1);
    if (
      !owningPartner
      || owningPartner.status !== 'active'
      || owningPartner.deletedAt !== null
    ) {
      return { denied: 'session_not_owned' as const };
    }

    const [orgMembershipRows, partnerMembershipRows] = await Promise.all([
      db.select({ roleId: organizationUsers.roleId, siteIds: organizationUsers.siteIds })
        .from(organizationUsers).where(and(eq(organizationUsers.userId, user.id), eq(organizationUsers.orgId, joined.session.orgId))).limit(1),
      db.select({ roleId: partnerUsers.roleId, orgAccess: partnerUsers.orgAccess, orgIds: partnerUsers.orgIds })
        .from(partnerUsers).where(and(eq(partnerUsers.userId, user.id), eq(partnerUsers.partnerId, user.partnerId))).limit(1),
    ]);
    const orgMembership = orgMembershipRows[0];
    const partnerMembership = partnerMembershipRows[0];
    let roleId: string | null = null;
    if (orgMembership?.roleId) {
      roleId = orgMembership.roleId;
      if (orgMembership.siteIds !== null && !orgMembership.siteIds.includes(joined.device.siteId)) return { denied: 'site_denied' as const };
    } else if (partnerMembership?.roleId && organization.partnerId === user.partnerId && partnerCanAccessOrg(partnerMembership, joined.session.orgId)) {
      roleId = partnerMembership.roleId;
    } else return { denied: 'session_not_owned' as const };

    const grants = await db.select({ resource: permissions.resource, action: permissions.action })
      .from(rolePermissions).innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
      .where(eq(rolePermissions.roleId, roleId));
    if (!requiredPermissions.every((required) => hasPermission(grants, required))) return { denied: 'permission_denied' as const };

    const capability = consumed.sessionType === 'terminal' ? 'remoteTools'
      : consumed.sessionType === 'desktop' ? 'webrtcDesktop'
        : joined.session.type === 'vnc' ? 'vncRelay' : 'proxy';
    const policy = bypassPolicyCache
      ? await checkRemoteAccess(joined.device.id, capability, { bypassCache: true })
      : await checkRemoteAccess(joined.device.id, capability);
    if (!policy.allowed) return { denied: 'policy_denied' as const };

    // Desktop/terminal continuation re-proves partner trust. Tunnel lifecycle
    // is a separate transport boundary and remains with its existing route
    // admission gates until its own live-continuation work is adopted.
    if (bypassPolicyCache && consumed.sessionType !== 'tunnel' && partnerTrustMode() !== 'off') {
      if (!('partner' in joined)) return { denied: 'partner_trust_denied' as const };
      const trust = evaluateCapabilityContinuationForState(
        'remote_control',
        {
          partnerId: joined.partner.id,
          deviceId: joined.device.id,
          orgId: joined.session.orgId,
          userId: user.id,
          detail: { stage: 'live', kind: consumed.sessionType },
        },
        joined.partner,
      );
      if (!trust.allow) return { denied: 'partner_trust_denied' as const };
    }
    return { user, session: joined.session, device: joined.device };
  }));
}

export async function authorizeLiveRemoteSessionAccess(
  subject: Pick<ConsumedRemoteWsTicketContext, 'sessionId' | 'sessionType' | 'userId'>,
  accessMode: 'live' | 'failure-diagnostics' = 'live',
): Promise<LiveRemoteSessionAuthorizationResult> {
  try {
    const live = await resolveRemoteWsLiveAuthority(
      subject, false, undefined, [PERMISSIONS.REMOTE_ACCESS], accessMode,
    );
    if ('denied' in live && live.denied !== undefined) {
      const status = live.denied === 'session_missing' ? 404
        : live.denied === 'device_offline' ? 503 : 403;
      return { ok: false, status, reason: live.denied };
    }
    return { ok: true, user: live.user, session: live.session, device: live.device };
  } catch {
    return { ok: false, status: 503, reason: 'authorization_unavailable' };
  }
}

export async function revalidateRemoteWsAuthority(
  subject: Pick<ConsumedRemoteWsTicketContext, 'sessionId' | 'sessionType' | 'userId'>,
  statementTimeoutMs = REMOTE_WS_LIVE_AUTHORIZATION_TIMEOUT_MS,
): Promise<RemoteWsLiveAuthorizationResult> {
  try {
    const live = await resolveRemoteWsLiveAuthority(
      subject,
      true,
      statementTimeoutMs,
    );
    if ('denied' in live && live.denied !== undefined) {
      const status = live.denied === 'session_missing' ? 404 : live.denied === 'device_offline' ? 503 : 403;
      return { ok: false, status, reason: live.denied };
    }
    return { ok: true };
  } catch {
    return { ok: false, status: 503, reason: 'authorization_unavailable' };
  }
}

export async function revalidateRemoteWsAuthorityBounded(
  subject: Pick<ConsumedRemoteWsTicketContext, 'sessionId' | 'sessionType' | 'userId'>,
  timeoutMs = REMOTE_WS_LIVE_AUTHORIZATION_TIMEOUT_MS,
): Promise<RemoteWsLiveAuthorizationResult> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const unavailable = new Promise<RemoteWsLiveAuthorizationResult>((resolve) => {
    timeout = setTimeout(() => resolve({ ok: false, status: 503, reason: 'authorization_unavailable' }), timeoutMs);
  });
  try { return await Promise.race([revalidateRemoteWsAuthority(subject, timeoutMs), unavailable]); }
  finally { if (timeout) clearTimeout(timeout); }
}

export async function authorizeRemoteSessionContinuation(
  consumed: Pick<ConsumedRemoteWsTicketContext, 'sessionId' | 'sessionType' | 'userId'>,
  requiredPermissions: Permission[] = [PERMISSIONS.REMOTE_ACCESS],
): Promise<RemoteSessionContinuationResult> {
  try {
    const live = await resolveRemoteWsLiveAuthority(consumed, false, undefined, requiredPermissions);
    if ('denied' in live && live.denied !== undefined) {
      const status = live.denied === 'session_missing'
        ? 404
        : live.denied === 'device_offline'
          ? 503
          : 403;
      return { ok: false, status, reason: live.denied };
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
      },
    };
  } catch {
    return { ok: false, status: 503, reason: 'authorization_unavailable' };
  }
}

export async function authorizeConsumedRemoteWsTicket(
  consumed: ConsumedRemoteWsTicketContext,
): Promise<RemoteWsAuthorizationResult> {
  const requiredPermissions = consumed.sessionType === 'tunnel'
    ? [PERMISSIONS.REMOTE_ACCESS, PERMISSIONS.DEVICES_EXECUTE]
    : [PERMISSIONS.REMOTE_ACCESS];
  const authorized = await authorizeRemoteSessionContinuation(consumed, requiredPermissions);
  if (!authorized.ok) return authorized;

  try {
    const limit = await rateLimiter(
      getRedis(),
      `${consumed.sessionType}ws:conn:${consumed.userId}`,
      REMOTE_WS_RATE_LIMIT,
      REMOTE_WS_RATE_WINDOW_SECONDS,
    );
    if (!limit.allowed) {
      return { ok: false, status: 429, reason: 'rate_limited' };
    }
  } catch {
    return { ok: false, status: 503, reason: 'authorization_unavailable' };
  }

  return {
    ok: true,
    context: {
      ...authorized.context,
      ticketAssurance: consumed.ticketAssurance,
      ticketJti: consumed.ticketJti,
    },
  };
}
