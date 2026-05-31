/**
 * Remote Access Policy Enforcement
 *
 * Resolves the effective `remote_access` configuration policy for a device
 * and provides granular capability checks. Used by remote session, tunnel,
 * system tool, and WebSocket routes to block access when policy disables it.
 *
 * When no policy is assigned, all capabilities default to enabled (permissive).
 */

import { resolveEffectiveConfig } from './configurationPolicy';
import type { AuthContext } from '../middleware/auth';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RemoteAccessSettings {
  webrtcDesktop: boolean;
  vncRelay: boolean;
  remoteTools: boolean;
  // Clipboard sync over the WebRTC desktop channel, gated per direction and
  // enforced agent-side (the viewer is untrusted, so the agent must not open
  // the channel / run the watcher when disabled). Finding #7.
  //   clipboardHostToViewer = remote machine's clipboard streamed to the
  //     operator's viewer — the silent-exfiltration vector (passwords / MFA
  //     codes / secrets the end user copies leak within ~500ms).
  //   clipboardViewerToHost = operator pasting into the remote machine
  //     (operator-initiated, lower risk).
  clipboardHostToViewer: boolean;
  clipboardViewerToHost: boolean;
  enableProxy: boolean;
  defaultAllowedPorts: number[];
  autoEnableProxy: boolean;
  maxConcurrentTunnels: number;
  idleTimeoutMinutes: number;
  maxSessionDurationHours: number;
}

export interface PolicyCheckResult {
  allowed: boolean;
  reason?: string;
  policyName?: string;
  policyId?: string;
}

export type RemoteCapability = 'webrtcDesktop' | 'vncRelay' | 'remoteTools' | 'proxy';

// Hosted multi-tenant SaaS defaults the silent-exfil direction (remote host
// clipboard → operator viewer) OFF, so an MSP operator can't passively harvest
// whatever a customer copies during a session. Operator→host paste stays on for
// usability. Self-hosted (single-tenant, IS_HOSTED!='true') preserves the
// historical bidirectional default so an upgrade doesn't silently change
// behavior for an admin running their own instance. Either way an explicit
// policy overrides these. Finding #7.
const isHosted = process.env.IS_HOSTED === 'true';

const DEFAULTS: RemoteAccessSettings = {
  webrtcDesktop: true,
  vncRelay: true,
  remoteTools: true,
  clipboardHostToViewer: !isHosted,
  clipboardViewerToHost: true,
  enableProxy: true,
  defaultAllowedPorts: [],
  autoEnableProxy: false,
  maxConcurrentTunnels: 5,
  idleTimeoutMinutes: 5,
  maxSessionDurationHours: 8,
};

const CAPABILITY_LABELS: Record<RemoteCapability, string> = {
  webrtcDesktop: 'Remote desktop',
  vncRelay: 'VNC relay',
  remoteTools: 'Remote tools',
  proxy: 'Network proxy',
};

// ---------------------------------------------------------------------------
// Cache — simple in-memory TTL (30 s)
// ---------------------------------------------------------------------------

interface CacheEntry {
  settings: RemoteAccessSettings;
  policyName: string | null;
  policyId: string | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30_000;

// Sweep stale entries every 60 s
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
}, 60_000).unref();

export function invalidateRemoteAccessCache(deviceId?: string): void {
  if (deviceId) {
    cache.delete(deviceId);
  } else {
    cache.clear();
  }
}

// ---------------------------------------------------------------------------
// System-scoped auth (no org filter) for internal resolution
// ---------------------------------------------------------------------------

const systemAuth: AuthContext = {
  user: { id: 'system', email: 'system', name: 'System', isPlatformAdmin: false },
  token: {} as any,
  partnerId: null,
  orgId: null,
  scope: 'system',
  accessibleOrgIds: null,
  orgCondition: () => undefined,
  canAccessOrg: () => true,
};

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

interface ResolvedRemoteAccess {
  settings: RemoteAccessSettings;
  policyName: string | null;
  policyId: string | null;
}

export async function resolveRemoteAccessForDevice(deviceId: string): Promise<ResolvedRemoteAccess> {
  // Check cache
  const now = Date.now();
  const cached = cache.get(deviceId);
  if (cached && cached.expiresAt > now) {
    return { settings: cached.settings, policyName: cached.policyName, policyId: cached.policyId };
  }

  // Resolve via the generic config policy engine
  const effective = await resolveEffectiveConfig(deviceId, systemAuth);

  let settings = { ...DEFAULTS };
  let policyName: string | null = null;
  let policyId: string | null = null;

  if (effective?.features?.remote_access) {
    const feature = effective.features.remote_access;
    const inline = (feature.inlineSettings ?? {}) as Partial<RemoteAccessSettings>;
    settings = { ...DEFAULTS, ...inline };
    policyName = feature.sourcePolicyName ?? null;
    policyId = feature.sourcePolicyId ?? null;
  }

  // Only cache successful resolutions (don't cache when device not found)
  if (effective) {
    cache.set(deviceId, { settings, policyName, policyId, expiresAt: now + CACHE_TTL_MS });
  }

  return { settings, policyName, policyId };
}

// ---------------------------------------------------------------------------
// Granular capability checks
// ---------------------------------------------------------------------------

export async function checkRemoteAccess(
  deviceId: string,
  capability: RemoteCapability
): Promise<PolicyCheckResult> {
  let settings: RemoteAccessSettings;
  let policyName: string | null = null;
  let policyId: string | null = null;

  try {
    const resolved = await resolveRemoteAccessForDevice(deviceId);
    settings = resolved.settings;
    policyName = resolved.policyName;
    policyId = resolved.policyId;
  } catch (err) {
    // Fail-closed: deny access when policy resolution fails
    console.error(
      `[RemoteAccessPolicy] Failed to resolve policy for device ${deviceId}, capability=${capability}:`,
      err instanceof Error ? err.message : err
    );
    return {
      allowed: false,
      reason: 'Unable to verify remote access policy. Please try again or contact your administrator.',
    };
  }

  const settingsKey = capability === 'proxy' ? 'enableProxy' : capability;
  const allowed = settings[settingsKey] === true;

  if (allowed) {
    return { allowed: true };
  }

  const label = CAPABILITY_LABELS[capability];
  const policyRef = policyName ? ` by policy "${policyName}"` : ' by configuration policy';
  return {
    allowed: false,
    reason: `${label} is disabled${policyRef}`,
    policyName: policyName ?? undefined,
    policyId: policyId ?? undefined,
  };
}

/**
 * Resolve the agent-enforced desktop session policy fields that ride along in
 * the `start_desktop` payload. Centralizes the mapping so both offer handlers
 * (JWT path in remote/sessions.ts and viewer-token path in desktopWs.ts) push
 * the agent the same clipboard + session-lifetime policy. The agent enforces
 * these because the viewer is untrusted. Findings #2 and #7.
 */
export interface DesktopSessionPolicy {
  clipboard: { hostToViewer: boolean; viewerToHost: boolean };
  idleTimeoutMinutes: number;
  maxSessionDurationHours: number;
}

export async function resolveDesktopSessionPolicy(deviceId: string): Promise<DesktopSessionPolicy> {
  const { settings } = await resolveRemoteAccessForDevice(deviceId);
  return {
    clipboard: {
      hostToViewer: settings.clipboardHostToViewer,
      viewerToHost: settings.clipboardViewerToHost,
    },
    idleTimeoutMinutes: settings.idleTimeoutMinutes,
    maxSessionDurationHours: settings.maxSessionDurationHours,
  };
}
