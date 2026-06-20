import { and, eq, sql, inArray, lte, or } from 'drizzle-orm';
import { createHmac, randomBytes } from 'crypto';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { captureException } from '../../services/sentry';
import {
  remoteSessions,
  fileTransfers,
  devices,
  auditLogs,
  configPolicyFeatureLinks,
  configPolicyRemoteAccessSettings
} from '../../db/schema';
import { canAccessSite, type UserPermissions } from '../../services/permissions';
import { revokeViewerSession } from '../../services/viewerTokenRevocation';
import type { AuthContext } from '../../middleware/auth';

// ============================================
// TURN CREDENTIAL GENERATION (RFC 5389 time-limited HMAC)
// ============================================

export type TurnCredentialScope = {
  sessionId: string;
  userId: string;
  deviceId?: string | null;
};

export function getTurnCredentialTtlSeconds(): number {
  const raw = Number.parseInt(process.env.TURN_CREDENTIAL_TTL_SECONDS ?? '', 10);
  if (!Number.isFinite(raw)) return 600;
  return Math.max(60, Math.min(raw, 900));
}

function turnScopeSegment(scope: TurnCredentialScope): string {
  const parts = [
    scope.userId.slice(0, 12),
    scope.sessionId.slice(0, 12),
    (scope.deviceId ?? 'no-device').slice(0, 12),
    randomBytes(8).toString('base64url'),
  ];
  return parts.join('.');
}

export function generateTurnCredentials(scope: TurnCredentialScope): { username: string; credential: string; ttlSeconds: number; expiresAt: number } | null {
  const secret = process.env.TURN_SECRET;
  if (!secret) return null;

  const ttl = getTurnCredentialTtlSeconds();
  const expiry = Math.floor(Date.now() / 1000) + ttl;
  const username = `${expiry}:breeze:${turnScopeSegment(scope)}`;
  // TURN credential generation commonly uses HMAC-SHA1 with a shared secret on the TURN server.
  // This is not used for password storage or encryption; if your TURN server supports HMAC-SHA256,
  // prefer switching to it on both ends.
  // lgtm[js/weak-cryptographic-algorithm]
  const credential = createHmac('sha1', secret).update(username).digest('base64');

  return { username, credential, ttlSeconds: ttl, expiresAt: expiry };
}

export function getIceServers(scope?: TurnCredentialScope): Array<{ urls: string | string[]; username?: string; credential?: string }> {
  const servers: Array<{ urls: string | string[]; username?: string; credential?: string }> = [
    { urls: 'stun:stun.l.google.com:19302' }
  ];

  const turnHost = process.env.TURN_HOST;
  const turnPort = process.env.TURN_PORT || '3478';

  if (turnHost && scope) {
    const creds = generateTurnCredentials(scope);
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

export async function getDeviceWithOrgCheck(
  deviceId: string,
  auth: { canAccessOrg: (orgId: string) => boolean },
  permissions?: UserPermissions,
) {
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

  if (permissions?.allowedSiteIds && (typeof device.siteId !== 'string' || !canAccessSite(permissions, device.siteId))) {
    return 'SITE_ACCESS_DENIED' as const;
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

  // Kill viewer tokens for sessions we just force-ended so a still-valid token
  // can't resurrect them via /viewer/offer (#5). Revocation must ALWAYS run, so
  // capture the expired ids via `.returning()` directly — no duck-type guard.
  const expired = await db
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
    )
    .returning({ id: remoteSessions.id });
  await Promise.all(expired.map((row) => revokeViewerSession(row.id)));
}

export async function expireStaleSessionsForUser(userId: string) {
  const now = new Date();
  const pendingCutoff = new Date(now.getTime() - 5 * 60 * 1000);
  const connectingCutoff = new Date(now.getTime() - 2 * 60 * 1000);

  // Kill viewer tokens for sessions we just force-ended so a still-valid token
  // can't resurrect them via /viewer/offer (#5). Revocation must ALWAYS run, so
  // capture the expired ids via `.returning()` directly — no duck-type guard.
  const expired = await db
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
    )
    .returning({ id: remoteSessions.id });
  await Promise.all(expired.map((row) => revokeViewerSession(row.id)));
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

// Log audit event for session activity.
//
// Runs on a connection OUTSIDE the caller's request transaction — same pattern
// as `createAuditLog` in `services/auditService.ts`. Two reasons:
//   1. RLS satisfaction on paths that don't establish their own DB context
//      (e.g. the viewer-token desktop WS handlers). A nested `withDbAccessContext`
//      would short-circuit to a no-op under an existing context, so we explicitly
//      `runOutsideDbContext` → `withSystemDbAccessContext` to force a fresh
//      system-scope transaction on a separate pooled connection.
//   2. Tx isolation. If the audit insert fails inside the caller's request
//      transaction, Postgres aborts the whole tx and silently rolls back the
//      caller's real work (session creation, transfer creation) even though
//      the route returned 200 — because this function swallows the error.
//      Running outside the caller's tx isolates audit-write failures from
//      business writes.
export async function logSessionAudit(
  action: string,
  actorId: string,
  orgId: string,
  details: Record<string, unknown>,
  ipAddress?: string
) {
  try {
    await runOutsideDbContext(() =>
      withSystemDbAccessContext(async () => {
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
      })
    );
  } catch (error) {
    // Escalate to Sentry as well as stdout: #437 went undetected for months
    // because the helper only logged to stdout and nobody alerts on that.
    console.error('Failed to log session audit:', error);
    captureException(error);
  }
}

// ============================================
// REMOTE SESSION CONSENT / NOTIFICATION PROMPT POLICY
// ============================================

/** The two audit actions a consent-denied outcome can be recorded under. */
export type ConsentDenyAuditAction = 'session_consent_denied' | 'session_consent_bypassed';

/**
 * Classify a consent-deny `reason` into its audit action. A genuine user denial
 * or a consent timeout is a real "denied" decision; any other reason (no user
 * present, helper absent, a malformed helper reply, or an operator policy
 * choosing proceed-then-block) is a bypass/unavailable outcome, audited
 * distinctly. Single source of truth shared by the agent's WS command-result
 * path (agentWs.ts) and the operator deny route (sessions.ts) so the two cannot
 * drift on how the same reason is classified.
 */
export function classifyConsentDenyAction(reason: string): ConsentDenyAuditAction {
  return reason === 'user' || reason === 'timeout'
    ? 'session_consent_denied'
    : 'session_consent_bypassed';
}

/**
 * Resolve the desktop session id carried by an agent consent marker. The command
 * id is authoritative (`expected`); when the result body also carries a session
 * id it must match, otherwise the marker is rejected (returns null) rather than
 * trusting a mismatched/forged value. Returns null when no id can be trusted.
 */
export function resolveConsentMarkerSessionId(
  expected: string | null,
  fromResult: string | null
): string | null {
  if (!expected) return null;
  if (fromResult && fromResult !== expected) return null;
  return expected;
}

export type SessionPromptMode = 'off' | 'notify' | 'consent';
export type ConsentUnavailableBehavior = 'proceed' | 'block';
export type TechnicianIdentityLevel = 'name_email' | 'name' | 'generic';

export interface RemoteSessionPromptConfig {
  mode: SessionPromptMode;
  consentUnavailableBehavior: ConsentUnavailableBehavior;
  notifyOnEnd: boolean;
  showIndicator: boolean;
  identityLevel: TechnicianIdentityLevel;
}

// Spec defaults applied when no `remote_access` policy resolves for the device,
// or when policy resolution fails. `notify` is the safe baseline: the end user is
// told a session is starting but is not asked to consent, so a resolution outage
// can never silently elevate to a fully-silent (`off`) session.
export const DEFAULT_REMOTE_SESSION_PROMPT_CONFIG: RemoteSessionPromptConfig = {
  mode: 'notify',
  consentUnavailableBehavior: 'proceed',
  notifyOnEnd: true,
  showIndicator: true,
  identityLevel: 'name_email',
};

// System-scope auth used to resolve the effective config without an org filter.
// Mirrors the `systemAuth` constant in services/remoteAccessPolicy.ts so internal
// policy resolution sees every assignment level regardless of the caller scope.
const promptConfigSystemAuth: AuthContext = {
  user: { id: 'system', email: 'system', name: 'System', isPlatformAdmin: false },
  token: {} as never,
  partnerId: null,
  orgId: null,
  scope: 'system',
  accessibleOrgIds: null,
  orgCondition: () => undefined,
  canAccessOrg: () => true,
};

function coercePromptMode(value: unknown): SessionPromptMode {
  return value === 'off' || value === 'notify' || value === 'consent'
    ? value
    : DEFAULT_REMOTE_SESSION_PROMPT_CONFIG.mode;
}

function coerceConsentUnavailable(value: unknown): ConsentUnavailableBehavior {
  return value === 'proceed' || value === 'block'
    ? value
    : DEFAULT_REMOTE_SESSION_PROMPT_CONFIG.consentUnavailableBehavior;
}

function coerceIdentityLevel(value: unknown): TechnicianIdentityLevel {
  return value === 'name_email' || value === 'name' || value === 'generic'
    ? value
    : DEFAULT_REMOTE_SESSION_PROMPT_CONFIG.identityLevel;
}

/**
 * Resolve the effective remote-session consent/notification prompt config for a
 * device. Resolves the effective `remote_access` configuration feature the same
 * way `resolveDesktopSessionPolicy` does (via `resolveEffectiveConfig`), then
 * reads the authoritative normalized `config_policy_remote_access_settings` row
 * by `featureLinkId`. Returns the spec defaults when no `remote_access` policy
 * applies, when the settings row is missing, or when resolution fails.
 *
 * Runs the DB work via `runOutsideDbContext` → `withSystemDbAccessContext` so it
 * works from paths that have no request-scoped DB context (e.g. viewer-token
 * desktop WS handlers) AND satisfies tenant isolation: the breeze_app pool needs
 * an explicit DB context or the SELECTs return 0 rows under FORCE RLS.
 */
export async function resolveRemoteSessionPromptConfig(
  deviceId: string
): Promise<RemoteSessionPromptConfig> {
  try {
    // Imported lazily so unit tests that mock `../../db/schema` with a partial
    // table set don't have to satisfy the full configurationPolicy import graph
    // just to exercise the pure `buildTechnicianDisplay` helper in this module.
    const { resolveEffectiveConfig } = await import('../../services/configurationPolicy');
    return await runOutsideDbContext(() =>
      withSystemDbAccessContext(async () => {
        const effective = await resolveEffectiveConfig(deviceId, promptConfigSystemAuth);
        const feature = effective?.features?.remote_access;
        if (!feature) {
          return { ...DEFAULT_REMOTE_SESSION_PROMPT_CONFIG };
        }

        // Find the remote_access feature link for the source policy, then read
        // the normalized settings row keyed on that link. The authoritative
        // values live in config_policy_remote_access_settings (the JSONB on the
        // feature link is only a UI/compat mirror).
        const [settings] = await db
          .select({
            sessionPromptMode: configPolicyRemoteAccessSettings.sessionPromptMode,
            consentUnavailableBehavior: configPolicyRemoteAccessSettings.consentUnavailableBehavior,
            notifyOnSessionEnd: configPolicyRemoteAccessSettings.notifyOnSessionEnd,
            showActiveIndicator: configPolicyRemoteAccessSettings.showActiveIndicator,
            technicianIdentityLevel: configPolicyRemoteAccessSettings.technicianIdentityLevel,
          })
          .from(configPolicyRemoteAccessSettings)
          .innerJoin(
            configPolicyFeatureLinks,
            eq(configPolicyRemoteAccessSettings.featureLinkId, configPolicyFeatureLinks.id)
          )
          .where(
            and(
              eq(configPolicyFeatureLinks.configPolicyId, feature.sourcePolicyId),
              eq(configPolicyFeatureLinks.featureType, 'remote_access')
            )
          )
          .limit(1);

        if (!settings) {
          return { ...DEFAULT_REMOTE_SESSION_PROMPT_CONFIG };
        }

        return {
          mode: coercePromptMode(settings.sessionPromptMode),
          consentUnavailableBehavior: coerceConsentUnavailable(settings.consentUnavailableBehavior),
          notifyOnEnd: settings.notifyOnSessionEnd ?? DEFAULT_REMOTE_SESSION_PROMPT_CONFIG.notifyOnEnd,
          showIndicator: settings.showActiveIndicator ?? DEFAULT_REMOTE_SESSION_PROMPT_CONFIG.showIndicator,
          identityLevel: coerceIdentityLevel(settings.technicianIdentityLevel),
        };
      })
    );
  } catch (error) {
    // Fail-safe to the spec defaults (mode 'notify') rather than 500-ing the
    // offer handler. A resolution outage must not silently produce a fully
    // silent session, nor block the operator entirely.
    console.error(
      `[RemoteSessionPrompt] Failed to resolve prompt config for device ${deviceId}; using defaults:`,
      error instanceof Error ? error.message : error
    );
    captureException(error);
    return { ...DEFAULT_REMOTE_SESSION_PROMPT_CONFIG };
  }
}

/**
 * Redact the technician identity shipped to the agent (and shown to the end user
 * in the consent/notification prompt) per the configured identity level:
 *   - `generic`    → no name, no email (only the org name is shown)
 *   - `name`       → name + org name, email dropped
 *   - `name_email` → name + email + org name (full)
 */
export function buildTechnicianDisplay(
  level: TechnicianIdentityLevel,
  name: string | null,
  email: string | null,
  orgName: string | null,
): { name: string | null; email: string | null; orgName: string | null } {
  if (level === 'generic') return { name: null, email: null, orgName };
  if (level === 'name') return { name, email: null, orgName };
  return { name, email, orgName };
}
