import { eq } from 'drizzle-orm';
import { parseSecurityScanSettings } from '@breeze/shared';

import { db } from '../db';
import { configPolicyFeatureLinks, configurationPolicies, devices, organizations } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import {
  authorityAdmitsDevice,
  captureSensitiveDataAuthority,
  decodeSensitiveDataAuthority,
  EMPTY_SENSITIVE_DATA_AUTHORITY,
  resolveSensitiveDataAuthorityInCurrentSystemContext,
  type PersistedSensitiveDataAuthority,
  type SensitiveDataAuthorityValues,
} from './sensitiveDataPolicyAuthority';

/**
 * Stored execution authority for IOC auto-quarantine.
 *
 * A configuration policy's `security` feature can carry `autoQuarantine`, and
 * scheduled scans fan out from policy assignment with no request behind them.
 * Quarantining a file is a device-execution effect, so the link stores the
 * same creator-bound envelope as a recurring sensitive-data policy
 * (`sensitiveDataPolicyAuthority.ts`), minted when a user with devices:execute
 * and MFA saves the link with auto-quarantine on.
 *
 * At dispatch the envelope is re-resolved live. If it does not resolve the
 * scan still runs — detect-only — and the scan row records why
 * (`security_scans.auto_quarantine_suppressed_reason`). Scans whose policy has
 * auto-quarantine off never consult this.
 */

export type QuarantineSuppressedReason =
  /** No envelope on the link (saved before stored authority, or by a path that cannot mint one). */
  | 'reapproval_required'
  /** The approving user is inactive or no longer holds devices:execute for the policy owner. */
  | 'authority_revoked'
  /** The device sits outside the approver's org/partner or site ceiling. */
  | 'device_out_of_scope'
  /** The authority could not be evaluated (lookup error). */
  | 'authority_unavailable';

export type QuarantineAuthorityDecision =
  | { allowed: true }
  | { allowed: false; reason: QuarantineSuppressedReason };

export type FeatureLinkAuthorityValues =
  | SensitiveDataAuthorityValues
  | typeof EMPTY_SENSITIVE_DATA_AUTHORITY;

/** The effective auto-quarantine flag of a security link's settings (defaults apply). */
export function securitySettingsAutoQuarantine(inlineSettings: unknown): boolean {
  return parseSecurityScanSettings(inlineSettings).autoQuarantine;
}

/** Mint the envelope for a security-link write by `auth` on a policy owned by `owner`. */
export function captureSecurityQuarantineAuthority(
  auth: AuthContext,
  owner: { orgId: string | null; partnerId: string | null },
): SensitiveDataAuthorityValues | null {
  if (owner.orgId) return captureSensitiveDataAuthority(auth, { orgId: owner.orgId, partnerId: null });
  if (owner.partnerId) return captureSensitiveDataAuthority(auth, { orgId: null, partnerId: owner.partnerId });
  return null;
}

/**
 * The authority columns to persist alongside a feature-link settings write, or
 * `undefined` to leave them untouched (not a security link).
 *
 * A security link keeps an envelope only while its effective settings have
 * auto-quarantine on AND the caller supplied a freshly captured authority.
 * Every other security write clears it — a settings change by a path that
 * cannot mint authority (AI tools, internal callers) downgrades the policy to
 * detect-only rather than inheriting an earlier approval.
 */
export function securityLinkAuthorityColumns(
  featureType: string,
  inlineSettings: unknown,
  executionAuthority: SensitiveDataAuthorityValues | null | undefined,
): FeatureLinkAuthorityValues | undefined {
  if (featureType !== 'security') return undefined;
  if (executionAuthority && securitySettingsAutoQuarantine(inlineSettings)) return executionAuthority;
  return EMPTY_SENSITIVE_DATA_AUTHORITY;
}

type LinkAuthorityColumns = Omit<PersistedSensitiveDataAuthority, 'orgId' | 'partnerId'>;

/** Static approval state of a security link for API responses (live revocation is checked at dispatch). */
export function describeQuarantineApproval(
  link: { featureType: string; inlineSettings: unknown } & LinkAuthorityColumns,
  owner: { orgId: string | null; partnerId: string | null },
): 'approved' | 'reapproval_required' | 'not_enabled' | undefined {
  if (link.featureType !== 'security') return undefined;
  if (!securitySettingsAutoQuarantine(link.inlineSettings)) return 'not_enabled';
  return decodeSensitiveDataAuthority({ ...owner, ...pickAuthority(link) }) ? 'approved' : 'reapproval_required';
}

function pickAuthority(row: LinkAuthorityColumns): LinkAuthorityColumns {
  return {
    executionAuthorityVersion: row.executionAuthorityVersion ?? null,
    executionAuthorityKind: row.executionAuthorityKind ?? null,
    executionAuthoritySiteIds: row.executionAuthoritySiteIds ?? null,
    executionAuthorityUserId: row.executionAuthorityUserId ?? null,
    executionAuthorityPrincipalKind: row.executionAuthorityPrincipalKind ?? null,
    executionAuthorityFingerprint: row.executionAuthorityFingerprint ?? null,
    executionAuthorityCapturedAt: row.executionAuthorityCapturedAt ?? null,
    executionAuthorityGeneration: row.executionAuthorityGeneration ?? null,
  };
}

/** Strip the raw envelope from a feature-link row before it leaves the API. */
export function withoutFeatureLinkAuthority<T extends Partial<LinkAuthorityColumns>>(row: T) {
  const {
    executionAuthorityVersion: _version,
    executionAuthorityKind: _kind,
    executionAuthoritySiteIds: _siteIds,
    executionAuthorityUserId: _userId,
    executionAuthorityPrincipalKind: _principalKind,
    executionAuthorityFingerprint: _fingerprint,
    executionAuthorityCapturedAt: _capturedAt,
    executionAuthorityGeneration: _generation,
    ...visible
  } = row;
  return visible;
}

/**
 * Live dispatch decision for the winning security link of a device. Must run
 * inside a system DB access context (the security-scan worker does): it reads
 * the approver's user, membership and role rows.
 */
export async function resolveSecurityScanQuarantineAuthority(
  featureLinkId: string,
  deviceId: string,
): Promise<QuarantineAuthorityDecision> {
  try {
    const [link] = await db
      .select({
        orgId: configurationPolicies.orgId,
        partnerId: configurationPolicies.partnerId,
        executionAuthorityVersion: configPolicyFeatureLinks.executionAuthorityVersion,
        executionAuthorityKind: configPolicyFeatureLinks.executionAuthorityKind,
        executionAuthoritySiteIds: configPolicyFeatureLinks.executionAuthoritySiteIds,
        executionAuthorityUserId: configPolicyFeatureLinks.executionAuthorityUserId,
        executionAuthorityPrincipalKind: configPolicyFeatureLinks.executionAuthorityPrincipalKind,
        executionAuthorityFingerprint: configPolicyFeatureLinks.executionAuthorityFingerprint,
        executionAuthorityCapturedAt: configPolicyFeatureLinks.executionAuthorityCapturedAt,
        executionAuthorityGeneration: configPolicyFeatureLinks.executionAuthorityGeneration,
      })
      .from(configPolicyFeatureLinks)
      // The link row's own policy is the AUTHOR of the setting — for an
      // inherited link that is the parent, whose owner the envelope binds.
      .innerJoin(configurationPolicies, eq(configurationPolicies.id, configPolicyFeatureLinks.configPolicyId))
      .where(eq(configPolicyFeatureLinks.id, featureLinkId))
      .limit(1);

    if (!link || !decodeSensitiveDataAuthority(link)) {
      return { allowed: false, reason: 'reapproval_required' };
    }

    const authority = await resolveSensitiveDataAuthorityInCurrentSystemContext(link);
    if (!authority) return { allowed: false, reason: 'authority_revoked' };

    const [device] = await db
      .select({ orgId: devices.orgId, siteId: devices.siteId, partnerId: organizations.partnerId })
      .from(devices)
      .innerJoin(organizations, eq(organizations.id, devices.orgId))
      .where(eq(devices.id, deviceId))
      .limit(1);
    const owner = link.orgId
      ? { orgId: link.orgId, partnerId: null }
      : { orgId: null, partnerId: link.partnerId! };
    if (!device || !authorityAdmitsDevice(authority, owner, device)) {
      return { allowed: false, reason: 'device_out_of_scope' };
    }
    return { allowed: true };
  } catch (error) {
    console.error('[SecurityScanQuarantineAuthority] authority resolution failed:', error);
    return { allowed: false, reason: 'authority_unavailable' };
  }
}
