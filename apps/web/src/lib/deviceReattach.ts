/**
 * Reattach a reinstalled machine to its existing device record (#8318 wave
 * 2-3, spec docs/superpowers/specs/installer-enrollment/2026-10-12-reinstall-reattach-design.md
 * §7.3, §8): the dialog's read, the step-up resource and the request body.
 *
 * The resource the `device_reattach` grant is minted for and the body that
 * spends it are built from ONE object, so the binding the server re-hashes
 * (apps/api/src/services/mfaStepUpGrant.ts deviceReattachResourceDigest) and
 * the body cannot drift. Dependency-free on purpose, like
 * lib/parkedAssignResource.ts.
 */

/** The comparison fields of one side, all reported by the device itself. */
export interface ReattachComparisonFields {
  hostname: string;
  displayName: string | null;
  osType: string;
  osVersion: string;
  agentVersion: string | null;
  status: string;
  enrolledAt: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  decommissionedAt: string | null;
  serialNumber: string | null;
  manufacturer: string | null;
  model: string | null;
  systemUuid: string | null;
}

export type ReattachEvidenceLevel = 'hint' | 'tpm_continuity';

/** One target of `GET /devices/:id/reinstall-candidates` (apps/api/src/services/reinstallCandidates/viewer.ts). */
export interface ReattachCandidate extends ReattachComparisonFields {
  deviceId: string;
  orgId: string;
  orgName: string | null;
  siteId: string;
  siteName: string | null;
  /** What matched, strongest first. */
  evidence: 'system_uuid' | 'serial' | 'hostname' | string;
  reason: string;
  evidenceLevel: ReattachEvidenceLevel;
  /** The candidate the source's possible-replacement link names. */
  flagged: boolean;
  osChanged: boolean;
  requiresRestore: boolean;
  /** Opaque version of the target's install; sent back and bound by the step-up. */
  targetVersion: string;
}

export interface ReattachOpenIntent {
  intentId: string;
  state: string;
  targetDeviceId: string;
  expiresAt: string;
}

export interface ReinstallCandidatesView {
  source: ReattachComparisonFields & {
    deviceId: string;
    parked: boolean;
    rebindSupported: boolean;
  };
  candidates: ReattachCandidate[];
  /** A possible reinstall exists that this viewer is not shown: it awaits partner review. */
  reviewPending: boolean;
  openIntent: ReattachOpenIntent | null;
  evidenceNotice: string;
}

/** The 202 answer of `POST /devices/:id/reattach`. */
export interface ReattachRequestedIntent {
  id: string;
  state: string;
  sourceDeviceId: string;
  targetDeviceId: string;
  evidenceLevel: ReattachEvidenceLevel;
  restoreDecommissioned: boolean;
  requestedAt: string;
  expiresAt: string;
}

export function reinstallCandidatesPath(sourceDeviceId: string): string {
  return `/devices/${encodeURIComponent(sourceDeviceId)}/reinstall-candidates`;
}

export function reattachPath(sourceDeviceId: string): string {
  return `/devices/${encodeURIComponent(sourceDeviceId)}/reattach`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Narrow the candidates read. A body that is not the expected shape is no
 * answer (null), never a half-built view the dialog would act on.
 */
export function parseReinstallCandidatesView(data: unknown): ReinstallCandidatesView | null {
  if (!isRecord(data) || !isRecord(data.source) || !Array.isArray(data.candidates)) return null;
  if (typeof data.source.deviceId !== 'string') return null;
  const candidates = data.candidates.filter((c): c is ReattachCandidate =>
    isRecord(c) && typeof c.deviceId === 'string' && typeof c.targetVersion === 'string'
    && typeof c.hostname === 'string');
  const openIntent = isRecord(data.openIntent) && typeof data.openIntent.intentId === 'string'
    ? data.openIntent as unknown as ReattachOpenIntent
    : null;
  return {
    source: data.source as unknown as ReinstallCandidatesView['source'],
    candidates,
    reviewPending: data.reviewPending === true,
    openIntent,
    evidenceNotice: typeof data.evidenceNotice === 'string' ? data.evidenceNotice : '',
  };
}

/** The `device_reattach` step-up resource (apps/api/src/routes/auth/schemas.ts deviceReattachStepUpResource). */
export interface DeviceReattachResource {
  sourceDeviceId: string;
  targetDeviceId: string;
  targetVersion: string;
  evidenceLevel: ReattachEvidenceLevel;
  restoreDecommissioned: boolean;
}

export function canonicalDeviceReattachResource(input: DeviceReattachResource): DeviceReattachResource {
  // Enumerated, never spread: the server schema is strict and digests exactly these keys.
  return {
    sourceDeviceId: input.sourceDeviceId,
    targetDeviceId: input.targetDeviceId,
    targetVersion: input.targetVersion,
    evidenceLevel: input.evidenceLevel,
    restoreDecommissioned: input.restoreDecommissioned === true,
  };
}

/** Body for `POST /devices/:id/reattach` (apps/api/src/routes/devices/reattach.ts reattachBodySchema, strict). */
export function deviceReattachRequestBody(
  resource: DeviceReattachResource,
  opts: { confirmTargetName: string; acknowledgeOsChange: boolean; stepUpGrant?: string },
): {
  targetDeviceId: string;
  targetVersion: string;
  possessionConfirmed: true;
  confirmTargetName: string;
  restoreDecommissioned: boolean;
  acknowledgeOsChange: boolean;
  stepUpGrant?: string;
} {
  return {
    targetDeviceId: resource.targetDeviceId,
    targetVersion: resource.targetVersion,
    possessionConfirmed: true,
    confirmTargetName: opts.confirmTargetName.trim(),
    restoreDecommissioned: resource.restoreDecommissioned === true,
    acknowledgeOsChange: opts.acknowledgeOsChange,
    ...(opts.stepUpGrant ? { stepUpGrant: opts.stepUpGrant } : {}),
  };
}

/** The typed confirmation, compared as the server does: trimmed, case-insensitive. */
export function confirmTargetNameMatches(typed: string, hostname: string): boolean {
  const value = typed.trim().toLowerCase();
  return value.length > 0 && value === hostname.trim().toLowerCase();
}

/**
 * Refusal codes the dialog has its own words for (services/deviceReattach/*,
 * middleware/auth.ts requireMfa). Anything else shows the server's message.
 */
export const REATTACH_REFUSAL_CODES = [
  'device_not_found',
  'not_partner_user',
  'user_inactive',
  'permission_denied',
  'org_access_denied',
  'full_admin_required',
  'partner_mismatch',
  'MFA_REQUIRED',
  'target_alive',
  'liveness_unknown',
  'os_changed',
  'target_changed',
  'rebind_unsupported',
  'source_decommissioned',
  'source_ineligible',
  'target_ephemeral',
  'target_decommissioned',
  'target_ineligible',
  'target_retired',
  'device_quarantined',
  'device_suspended',
  'org_draining',
  'device_in_open_intent',
  'confirm_target_name_required',
  'confirm_target_name_mismatch',
  'same_device',
  'invalid_target_version',
] as const;

export type ReattachRefusalCode = (typeof REATTACH_REFUSAL_CODES)[number];

export function isKnownReattachRefusal(code: string | undefined): code is ReattachRefusalCode {
  return code !== undefined && (REATTACH_REFUSAL_CODES as readonly string[]).includes(code);
}
