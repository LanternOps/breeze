import { and, eq, sql, inArray } from 'drizzle-orm';
import { createHmac, randomBytes, randomUUID } from 'crypto';
import { db, hasDbAccessContext, runOutsideDbContext, withDbTransaction, withSystemDbAccessContext } from '../../db';
import { captureException } from '../../services/sentry';
import { remoteSessionStaleCondition } from '../../services/remoteSessionStaleness';
import { terminalIntentSet } from '../../services/remoteDesktopTerminalIntent';
import {
  remoteSessions,
  devices,
  auditLogs,
  configPolicyEffectiveFeatureLinks,
  configPolicyRemoteAccessSettings,
  users,
  organizations,
  partners
} from '../../db/schema';
import { canAccessSite, type UserPermissions } from '../../services/permissions';
import { revokeViewerSession } from '../../services/viewerTokenRevocation';
import type { AuthContext } from '../../middleware/auth';
import { DESKTOP_CONSENT_TIMEOUT_MS } from './consentTiming';
import { RemoteSessionPromptPolicyError } from './consentGate';
import { getRedis } from '../../services/redis';
import { rateLimiter } from '../../services/rate-limit';
import { markRequestAuditWritten } from '../../services/auditRequestTracking';

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

  // TURNS (TLS) is opt-in and needs its own hostname: the certificate must
  // validate, and TURN_HOST is documented as a bare public IP. Operators who
  // terminate TLS on the bundled coturn set TURN_TLS_HOST to the FQDN on the
  // certificate. Unset => plain turn: only, exactly as before (#6163).
  const turnTlsHost = process.env.TURN_TLS_HOST;
  const turnTlsPort = process.env.TURN_TLS_PORT || '5349';

  if (turnHost && scope) {
    const creds = generateTurnCredentials(scope);
    if (creds) {
      const urls = [
        `turn:${turnHost}:${turnPort}?transport=udp`,
        `turn:${turnHost}:${turnPort}?transport=tcp`
      ];
      // TURNS is TCP-only: it is the fallback for networks that block UDP or
      // allow only a short list of TCP ports.
      if (turnTlsHost) urls.push(`turns:${turnTlsHost}:${turnTlsPort}?transport=tcp`);
      servers.push({
        urls,
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

export const MAX_ACTIVE_REMOTE_SESSIONS_PER_ORG = envInt('MAX_ACTIVE_REMOTE_SESSIONS_PER_ORG', 10);
export const MAX_ACTIVE_REMOTE_SESSIONS_PER_USER = envInt('MAX_ACTIVE_REMOTE_SESSIONS_PER_USER', 5);

// `/remote/ice-servers`
// can be called repeatedly for any session the caller owns. Each call mints a
// fresh TURN credential whose username carries a random suffix, so coturn's
// `user-quota` (keyed on username) never sees the same "user" twice and never
// engages. Bound the mint rate per caller independently of coturn config,
// which the API cannot see or control. Set to 0 to disable (e.g. hosted
// deployments confirmed to run no TURN relay at all).
export const TURN_CREDENTIAL_MINT_LIMIT = envInt('TURN_CREDENTIAL_MINT_LIMIT_PER_WINDOW', 30);
export const TURN_CREDENTIAL_MINT_WINDOW_SECONDS = envInt('TURN_CREDENTIAL_MINT_WINDOW_SECONDS', 600);

export async function checkTurnCredentialMintRateLimit(userId: string): Promise<{ allowed: boolean }> {
  if (TURN_CREDENTIAL_MINT_LIMIT <= 0) return { allowed: true };

  const redis = getRedis();
  const result = await rateLimiter(
    redis,
    `remote:ice-servers:mint:${userId}`,
    TURN_CREDENTIAL_MINT_LIMIT,
    TURN_CREDENTIAL_MINT_WINDOW_SECONDS
  );
  return { allowed: result.allowed };
}

export function hasSessionOwnership(
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

// Same org + site gate as getDeviceWithOrgCheck, reading only the columns a
// liveness check needs. For per-poll callers (the active-sessions banner),
// which would otherwise fetch the full devices row every minute per open page.
export async function getDeviceLivenessWithOrgCheck(
  deviceId: string,
  auth: { canAccessOrg: (orgId: string) => boolean },
  permissions?: UserPermissions,
) {
  const [device] = await db
    .select({
      id: devices.id,
      orgId: devices.orgId,
      siteId: devices.siteId,
      status: devices.status,
      lastSeenAt: devices.lastSeenAt,
    })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) {
    return null;
  }

  if (!ensureOrgAccess(device.orgId, auth)) {
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

// Auto-expire stale sessions that were never properly connected
export async function expireStaleSessions(orgId: string) {
  const now = new Date();

  // Kill viewer tokens for sessions we just force-ended so a still-valid token
  // can't resurrect them via /viewer/offer (#5). Revocation must ALWAYS run, so
  // capture the expired ids via `.returning()` directly — no duck-type guard.
  const expired = await db
    .update(remoteSessions)
    .set(terminalIntentSet({ status: 'disconnected', endedAt: now }, 'pending'))
    .where(
      and(
        inArray(remoteSessions.deviceId,
          db.select({ id: devices.id }).from(devices).where(eq(devices.orgId, orgId))
        ),
        remoteSessionStaleCondition(now)
      )
    )
    .returning({ id: remoteSessions.id });
  await Promise.all(expired.map((row) => revokeViewerSession(row.id)));
}

export async function expireStaleSessionsForUser(userId: string) {
  const now = new Date();

  // Kill viewer tokens for sessions we just force-ended so a still-valid token
  // can't resurrect them via /viewer/offer (#5). Revocation must ALWAYS run, so
  // capture the expired ids via `.returning()` directly — no duck-type guard.
  const expired = await db
    .update(remoteSessions)
    .set(terminalIntentSet({ status: 'disconnected', endedAt: now }, 'pending'))
    .where(
      and(
        eq(remoteSessions.userId, userId),
        remoteSessionStaleCondition(now)
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
  ipAddress?: string,
  actorType: 'user' | 'agent' | 'system' = 'user'
) {
  try {
    await runOutsideDbContext(() =>
      withSystemDbAccessContext(async () => {
        await db.insert(auditLogs).values({
          orgId,
          actorType,
          actorId,
          action,
          resourceType: 'remote_session',
          resourceId: details.sessionId as string,
          details,
          ipAddress,
          result: 'success'
        });
        markRequestAuditWritten();
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

/**
 * The audit actions a consent-denied (start refused) outcome can be recorded
 * under. `session_consent_bypassed` is deliberately NOT one of them: it is
 * written only when a consent-mode start PROCEEDED without an answer under a
 * bound `proceed` fallback (the activation path in agentWs.ts).
 */
export type ConsentDenyAuditAction =
  | 'session_consent_denied'
  | 'session_consent_blocked_unanswered'
  | 'session_consent_blocked_unavailable';

/**
 * Classify a consent-deny `reason` into its audit action:
 *   - `user`    → the end user explicitly declined (`session_consent_denied`)
 *   - `timeout` → the prompt went unanswered and the start was refused
 *                 (`session_consent_blocked_unanswered`)
 *   - anything else (no consent-capable helper, a malformed helper reply, an
 *     unknown reason) → the prompt could not be shown or answered and the
 *     start was refused (`session_consent_blocked_unavailable`).
 * The authenticated agent WS command-result path is the sole caller allowed to
 * report this endpoint decision.
 */
export function classifyConsentDenyAction(reason: string): ConsentDenyAuditAction {
  if (reason === 'user') return 'session_consent_denied';
  if (reason === 'timeout') return 'session_consent_blocked_unanswered';
  return 'session_consent_blocked_unavailable';
}

/**
 * Consent-mode start reasons that mean consent was never obtained from the end
 * user: no consent-capable helper was present (`helper_absent`, version 1
 * agents), nobody is signed in to the captured session (`no_user_session`,
 * version 2 agents), or the prompt went unanswered (`timeout`). A start
 * carrying one may activate only under a `proceed` fallback bound to that
 * start, and is audited as a bypass, never as a user grant (#6819).
 * `helper_unreachable` (someone is signed in but could not be asked) is
 * deliberately absent: it is only ever a refusal.
 */
export const UNSOLICITED_CONSENT_REASONS = ['helper_absent', 'timeout', 'no_user_session'] as const;
export type UnsolicitedConsentReason = typeof UNSOLICITED_CONSENT_REASONS[number];

/**
 * The structured consent record a desk-start result carries into its audit
 * row. A version 2 agent sends `consentProtocol: 2` plus the outcome fields; a
 * version 1 agent sends none, recorded as `consentProtocol: 1` so a reviewer
 * can tell a legacy report (which cannot distinguish "nobody signed in" from
 * "the prompt could not be shown") from a version 2 one. Only values the
 * result schema already validated reach here; anything else is omitted.
 */
export function consentMarkerAuditDetails(result: Record<string, unknown>): {
  consentProtocol: number;
  consentOutcome?: string;
  consentOccupancy?: string;
  consentDetail?: string;
} {
  const details: {
    consentProtocol: number;
    consentOutcome?: string;
    consentOccupancy?: string;
    consentDetail?: string;
  } = { consentProtocol: result.consentProtocol === 2 ? 2 : 1 };
  if (typeof result.consentOutcome === 'string') details.consentOutcome = result.consentOutcome;
  if (typeof result.consentOccupancy === 'string') details.consentOccupancy = result.consentOccupancy;
  if (typeof result.consentDetail === 'string') details.consentDetail = result.consentDetail;
  return details;
}

/**
 * Whether a desk-start result's consent marker is backed by its own outcome.
 * A version 2 agent (`consentProtocol: 2`) reports what happened to the prompt
 * alongside the reason, so a start may activate only when the two agree: a
 * `user` grant needs `granted`, `timeout` needs `presented_expired` (the prompt
 * was confirmed on screen), and `no_user_session` needs `unavailable`. Version
 * 1 markers carry no outcome and are left to the existing rules.
 */
export function consentMarkerIsCoherent(result: Record<string, unknown>): boolean {
  if (result.consentProtocol !== 2 || result.consentReason === undefined) return true;
  const required: Record<string, string> = {
    user: 'granted',
    timeout: 'presented_expired',
    no_user_session: 'unavailable',
  };
  const want = required[String(result.consentReason)];
  return want !== undefined && result.consentOutcome === want;
}

export function isUnsolicitedConsentReason(reason: unknown): reason is UnsolicitedConsentReason {
  return (UNSOLICITED_CONSENT_REASONS as readonly unknown[]).includes(reason);
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

const DESKTOP_START_COMMAND_RE = /^desk-start-(.+)-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

/** Create a one-off command identity for one exact desktop offer generation. */
export function createDesktopStartCommandId(sessionId: string): string {
  return `desk-start-${sessionId}-${randomUUID()}`;
}

/**
 * Parse only generation-bound start command identities. Legacy
 * `desk-start-<sessionId>` results intentionally fail closed after upgrade.
 */
export function parseDesktopStartCommandId(commandId: string): { sessionId: string; commandId: string } | null {
  const match = DESKTOP_START_COMMAND_RE.exec(commandId);
  if (!match?.[1]) return null;
  return { sessionId: match[1], commandId };
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

// Spec defaults applied when the device positively resolves with no
// `remote_access` policy at all. They are NEVER a fallback for a resolution
// failure or a malformed/incomplete policy: those refuse the session start
// (RemoteSessionPromptPolicyError), because falling back to `notify` would
// silently drop a consent requirement the device's policy may carry.
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
  principal: { kind: 'system', reason: 'remote-prompt-config-resolution' },
  user: { id: 'system', email: 'system', name: 'System', isPlatformAdmin: false },
  token: {} as never,
  partnerId: null,
  orgId: null,
  scope: 'system',
  accessibleOrgIds: null,
  orgCondition: () => undefined,
  canAccessOrg: () => true,
};

function isPromptMode(value: unknown): value is SessionPromptMode {
  return value === 'off' || value === 'notify' || value === 'consent';
}

function isConsentUnavailableBehavior(value: unknown): value is ConsentUnavailableBehavior {
  return value === 'proceed' || value === 'block';
}

function coerceIdentityLevel(value: unknown): TechnicianIdentityLevel {
  return value === 'name_email' || value === 'name' || value === 'generic'
    ? value
    : DEFAULT_REMOTE_SESSION_PROMPT_CONFIG.identityLevel;
}

// The consent/notification keys the remote_access link JSON mirrors into the
// normalized settings row (remoteAccessConsentSettingsSchema).
const PROMPT_SETTING_KEYS = [
  'sessionPromptMode',
  'consentUnavailableBehavior',
  'notifyOnSessionEnd',
  'showActiveIndicator',
  'technicianIdentityLevel',
] as const;

function linkCarriesPromptSettings(inlineSettings: unknown): boolean {
  if (!inlineSettings || typeof inlineSettings !== 'object') return false;
  return PROMPT_SETTING_KEYS.some((key) => key in (inlineSettings as Record<string, unknown>));
}

async function resolvePromptConfigInCurrentContext(
  deviceId: string,
  resolveEffectiveConfig: typeof import('../../services/configurationPolicy').resolveEffectiveConfig,
): Promise<RemoteSessionPromptConfig> {
  const effective = await resolveEffectiveConfig(deviceId, promptConfigSystemAuth);
  if (!effective) {
    throw new RemoteSessionPromptPolicyError(deviceId, 'effective configuration did not resolve');
  }
  const feature = effective.features?.remote_access;
  if (!feature) {
    // Positively established: the device resolved and no remote_access
    // policy applies to it.
    return { ...DEFAULT_REMOTE_SESSION_PROMPT_CONFIG };
  }

  // Find the remote_access feature link for the source policy, then read
  // the normalized settings row keyed on that link. The authoritative
  // values live in config_policy_remote_access_settings (the JSONB on the
  // feature link is only a UI/compat mirror).
  const [row] = await db
    .select({
      linkId: configPolicyEffectiveFeatureLinks.id,
      linkInlineSettings: configPolicyEffectiveFeatureLinks.inlineSettings,
      settingsId: configPolicyRemoteAccessSettings.id,
      sessionPromptMode: configPolicyRemoteAccessSettings.sessionPromptMode,
      consentUnavailableBehavior: configPolicyRemoteAccessSettings.consentUnavailableBehavior,
      notifyOnSessionEnd: configPolicyRemoteAccessSettings.notifyOnSessionEnd,
      showActiveIndicator: configPolicyRemoteAccessSettings.showActiveIndicator,
      technicianIdentityLevel: configPolicyRemoteAccessSettings.technicianIdentityLevel,
    })
    .from(configPolicyEffectiveFeatureLinks)
    .leftJoin(
      configPolicyRemoteAccessSettings,
      eq(configPolicyRemoteAccessSettings.featureLinkId, configPolicyEffectiveFeatureLinks.id)
    )
    .where(
      and(
        eq(configPolicyEffectiveFeatureLinks.configPolicyId, feature.sourcePolicyId),
        eq(configPolicyEffectiveFeatureLinks.featureType, 'remote_access')
      )
    )
    .limit(1);

  if (!row) {
    throw new RemoteSessionPromptPolicyError(
      deviceId,
      `remote_access feature link not found for policy ${feature.sourcePolicyId}`
    );
  }

  if (!row.settingsId) {
    if (linkCarriesPromptSettings(row.linkInlineSettings)) {
      throw new RemoteSessionPromptPolicyError(
        deviceId,
        `remote_access settings row missing for feature link ${row.linkId}`
      );
    }
    return { ...DEFAULT_REMOTE_SESSION_PROMPT_CONFIG };
  }

  if (!isPromptMode(row.sessionPromptMode)) {
    throw new RemoteSessionPromptPolicyError(
      deviceId,
      `invalid session prompt mode on feature link ${row.linkId}`
    );
  }
  if (!isConsentUnavailableBehavior(row.consentUnavailableBehavior)) {
    throw new RemoteSessionPromptPolicyError(
      deviceId,
      `invalid consent-unavailable behavior on feature link ${row.linkId}`
    );
  }

  return {
    mode: row.sessionPromptMode,
    consentUnavailableBehavior: row.consentUnavailableBehavior,
    notifyOnEnd: row.notifyOnSessionEnd ?? DEFAULT_REMOTE_SESSION_PROMPT_CONFIG.notifyOnEnd,
    showIndicator: row.showActiveIndicator ?? DEFAULT_REMOTE_SESSION_PROMPT_CONFIG.showIndicator,
    identityLevel: coerceIdentityLevel(row.technicianIdentityLevel),
  };
}

/**
 * Resolve the effective remote-session consent/notification prompt config for a
 * device. Resolves the effective `remote_access` configuration feature the same
 * way `resolveDesktopSessionPolicy` does (via `resolveEffectiveConfig`), then
 * reads the authoritative normalized `config_policy_remote_access_settings` row
 * by `featureLinkId`.
 *
 * Returns the spec defaults ONLY when the device resolves and no
 * `remote_access` policy applies to it. Throws `RemoteSessionPromptPolicyError`
 * when the policy cannot be established — see the class doc. One case needs a
 * rule of its own: a remote_access link with no normalized settings row. The
 * write path skips that row only when the link was saved without any settings
 * (null inline settings), and fills every prompt field it is not given with
 * the schema/column defaults, so:
 *   - link JSON carries no prompt keys → whatever the write path stored (or
 *     would have stored) is the defaults, so the defaults apply;
 *   - link JSON carries prompt keys → the row should exist and does not; the
 *     stored mode is unknown (it may be `consent`), so the start is refused.
 *
 * Reads in the caller's DB context when one is active (a request route, or a
 * system-context authorization check), inside a savepoint on that same
 * connection; RLS then applies as the caller. An org-scoped caller sees its
 * own org's policies plus its own partner's partner-wide policies (the
 * SELECT-only partner-wide branch on the configuration-policy tables), and a
 * device it cannot see does not resolve, which refuses rather than falling
 * back to `notify`. A caller with no DB context (viewer-token and WebSocket
 * handlers) gets a fresh system context: the breeze_app pool needs an explicit
 * context or the SELECTs return 0 rows under FORCE RLS.
 */
export async function resolveRemoteSessionPromptConfig(
  deviceId: string
): Promise<RemoteSessionPromptConfig> {
  try {
    // Imported lazily so unit tests that mock `../../db/schema` with a partial
    // table set don't have to satisfy the full configurationPolicy import graph
    // just to exercise the pure `buildTechnicianDisplay` helper in this module.
    const { resolveEffectiveConfig } = await import('../../services/configurationPolicy');
    const resolve = () => resolvePromptConfigInCurrentContext(deviceId, resolveEffectiveConfig);
    // Inside a request (or other) DB context, read on that context's own
    // connection, in a savepoint so a failed read cannot poison the caller's
    // transaction. Opening a second pooled connection while the caller holds
    // one can exhaust the pool under load. Only a caller with no DB context
    // gets a fresh system context.
    return hasDbAccessContext()
      ? await withDbTransaction(resolve)
      : await runOutsideDbContext(() => withSystemDbAccessContext(resolve));
  } catch (error) {
    // Refuse the start rather than fall back to `notify`: a lookup error or an
    // unreadable policy must never drop a consent requirement. Callers map
    // this error to a technician-facing "try again / re-save the policy".
    const policyError = error instanceof RemoteSessionPromptPolicyError
      ? error
      : new RemoteSessionPromptPolicyError(
        deviceId,
        error instanceof Error ? error.message : String(error),
        { cause: error }
      );
    console.error(`[RemoteSessionPrompt] ${policyError.message}; refusing the session start`);
    captureException(policyError);
    throw policyError;
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

/**
 * Build the `prompt` block for a start_desktop payload: the resolved
 * consent/notification policy plus the redacted technician identity. Returns
 * undefined when the policy mode is `off` (a fully silent session ships no
 * prompt block at all).
 *
 * Shared by the REST offer route (remote/sessions.ts) and the viewer-token WS
 * offer handler (desktopWs.ts) so the two start_desktop paths cannot drift —
 * the WS path shipping no prompt is exactly how the session notice + on-screen
 * banner silently disappeared for viewer-token sessions.
 *
 * Both lookups run in a system DB context: the WS handler has no
 * request-scoped context (a bare select would silently return 0 rows under
 * FORCE RLS), and the partner join is invisible to org-scoped callers anyway.
 * The dialog shows who the technician WORKS FOR — the MSP (partner) — not the
 * client org the device belongs to. Showing the client's own company name is
 * what a social engineer would claim anyway.
 *
 * Throws `RemoteSessionPromptPolicyError` when the prompt policy cannot be
 * established; callers refuse the start. The technician identity lookup is
 * display-only and stays best-effort.
 */
export async function buildRemoteSessionPromptPayload(
  device: { id: string; orgId: string },
  technicianUserId: string
): Promise<Record<string, unknown> | undefined> {
  const promptCfg = await resolveRemoteSessionPromptConfig(device.id);
  if (promptCfg.mode === 'off') return undefined;

  let techName: string | null = null;
  let techEmail: string | null = null;
  let partnerName: string | null = null;
  try {
    await runOutsideDbContext(() =>
      withSystemDbAccessContext(async () => {
        const [tech] = await db
          .select({ name: users.name, email: users.email })
          .from(users)
          .where(eq(users.id, technicianUserId))
          .limit(1);
        techName = tech?.name ?? null;
        techEmail = tech?.email ?? null;

        const [partnerRow] = await db
          .select({ name: partners.name })
          .from(organizations)
          .innerJoin(partners, eq(organizations.partnerId, partners.id))
          .where(eq(organizations.id, device.orgId))
          .limit(1);
        partnerName = partnerRow?.name ?? null;
      })
    );
  } catch (error) {
    // Fail-safe: the prompt still ships without the identity details rather
    // than 500-ing the offer handler — a throw here would strand the session
    // mid-start with the agent never commanded.
    console.error(
      `[RemoteSessionPrompt] Failed to resolve technician/partner identity for device ${device.id}; proceeding without it:`,
      error instanceof Error ? error.message : error
    );
    captureException(error);
  }

  const technicianDisplay = buildTechnicianDisplay(
    promptCfg.identityLevel,
    techName,
    techEmail,
    partnerName
  );
  // Identity fields are FLAT on the prompt block: the agent
  // (ipc.DesktopPrompt: technicianName/technicianEmail/orgName) and the Tauri
  // assist app (desktop.rs, ConsentDialog.tsx) all deserialize the top-level
  // keys. The previous nested `technicianDisplay` object was read by nothing,
  // so every end-user prompt fell back to "A technician".
  return {
    mode: promptCfg.mode,
    technicianName: technicianDisplay.name,
    technicianEmail: technicianDisplay.email,
    orgName: technicianDisplay.orgName,
    consentUnavailableBehavior: promptCfg.consentUnavailableBehavior,
    consentTimeoutMs: DESKTOP_CONSENT_TIMEOUT_MS,
    notifyOnEnd: promptCfg.notifyOnEnd,
    showIndicator: promptCfg.showIndicator,
  };
}

// Re-exported for the existing importers of these from this module.
export { CONSENT_PROMPT_PROTOCOL_VERSION, isConsentPromptCapable } from './consentGate';
