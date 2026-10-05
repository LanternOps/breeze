import { and, eq, isNull } from 'drizzle-orm';
import { parseSecurityScanSettings } from '@breeze/shared';

import { db } from '../db';
import { configPolicyFeatureLinks, configurationPolicies, devices, organizations } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import { captureException } from './sentry';
import {
  authorityAdmitsDevice,
  captureSensitiveDataAuthority,
  decodeSensitiveDataAuthority,
  EMPTY_SENSITIVE_DATA_AUTHORITY,
  resolveLegacyPrincipalExecuteAuthorityInCurrentSystemContext,
  resolveSensitiveDataAuthorityInCurrentSystemContext,
  type EffectiveSensitiveDataAuthority,
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
 *
 * Links that predate the envelope are grandfathered on the policy's creator
 * (`execution_authority_legacy = 'grandfathered'`): quarantine keeps working
 * while `configuration_policies.created_by` is active and holds
 * devices:execute for the policy owner, checked live with the same resolution
 * as a stamp. Neither the policy nor the link records an updater, so the
 * creator is the only principal on record; it is set from the authenticated
 * user on insert and never rewritten. The first failed check flips the link to
 * 'revoked' (detect-only, re-approval required), and any later write through
 * the feature-link service clears the legacy marker for good.
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
  (SensitiveDataAuthorityValues | typeof EMPTY_SENSITIVE_DATA_AUTHORITY) & { executionAuthorityLegacy: null };

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
  // Every security write leaves the legacy grandfathering path permanently.
  if (executionAuthority && securitySettingsAutoQuarantine(inlineSettings)) {
    return { ...executionAuthority, executionAuthorityLegacy: null };
  }
  return { ...EMPTY_SENSITIVE_DATA_AUTHORITY, executionAuthorityLegacy: null };
}

type LinkAuthorityColumns = Omit<PersistedSensitiveDataAuthority, 'orgId' | 'partnerId'>;

function hasEnvelope(row: LinkAuthorityColumns): boolean {
  return Object.values(pickAuthority(row)).some((value) => value !== null);
}

/** Static approval state of a security link for API responses (live revocation is checked at dispatch). */
export type QuarantineApproval = {
  status: 'approved' | 'legacy_grandfathered' | 'reapproval_required' | 'not_enabled';
  reason: 'approver_invalid' | 'not_approved' | 'invalid_approval' | null;
};

export function describeQuarantineApproval(
  link: {
    featureType: string;
    inlineSettings: unknown;
    executionAuthorityLegacy?: string | null;
    executionAuthorityStatus?: string | null;
  } & LinkAuthorityColumns,
  owner: { orgId: string | null; partnerId: string | null },
): QuarantineApproval | undefined {
  if (link.featureType !== 'security') return undefined;
  if (!securitySettingsAutoQuarantine(link.inlineSettings)) return { status: 'not_enabled', reason: null };
  if (!hasEnvelope(link)) {
    if (link.executionAuthorityLegacy === 'grandfathered') return { status: 'legacy_grandfathered', reason: null };
    if (link.executionAuthorityLegacy === 'revoked') return { status: 'reapproval_required', reason: 'approver_invalid' };
    return { status: 'reapproval_required', reason: 'not_approved' };
  }
  if (!decodeSensitiveDataAuthority({ ...owner, ...pickAuthority(link) })) {
    return { status: 'reapproval_required', reason: 'invalid_approval' };
  }
  // Intact stamp whose approver failed the last dispatch check: scans are
  // running detect-only, so do not keep reporting "approved". A transient
  // 'lookup_failed' does not claim the approval is gone.
  if (link.executionAuthorityStatus === 'approver_invalid') {
    return { status: 'reapproval_required', reason: 'approver_invalid' };
  }
  return { status: 'approved', reason: null };
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
export function withoutFeatureLinkAuthority<T extends Partial<LinkAuthorityColumns> & {
  executionAuthorityLegacy?: unknown;
  executionAuthorityStatus?: unknown;
  executionAuthorityStatusAt?: unknown;
}>(row: T) {
  const {
    executionAuthorityVersion: _version,
    executionAuthorityKind: _kind,
    executionAuthoritySiteIds: _siteIds,
    executionAuthorityUserId: _userId,
    executionAuthorityPrincipalKind: _principalKind,
    executionAuthorityFingerprint: _fingerprint,
    executionAuthorityCapturedAt: _capturedAt,
    executionAuthorityGeneration: _generation,
    executionAuthorityLegacy: _legacy,
    executionAuthorityStatus: _status,
    executionAuthorityStatusAt: _statusAt,
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
  const unavailable = (error: unknown): QuarantineAuthorityDecision => {
    console.error('[SecurityScanQuarantineAuthority] authority lookup failed:', error);
    captureException(error);
    return { allowed: false, reason: 'authority_unavailable' };
  };

  let rows;
  try {
    rows = await db
      .select({
        orgId: configurationPolicies.orgId,
        partnerId: configurationPolicies.partnerId,
        createdBy: configurationPolicies.createdBy,
        executionAuthorityLegacy: configPolicyFeatureLinks.executionAuthorityLegacy,
        executionAuthorityStatus: configPolicyFeatureLinks.executionAuthorityStatus,
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
  } catch (error) {
    return unavailable(error);
  }
  const link = rows[0];
  if (!link) return { allowed: false, reason: 'reapproval_required' };

  // Persist the check outcome, only when it changed, so the API/UI can say why
  // quarantine stopped. Revoking a grandfathered link is one-way.
  const record = async (status: 'ok' | 'approver_invalid' | 'lookup_failed', revokeLegacy = false) => {
    const statusChanged = status !== link.executionAuthorityStatus;
    if (!statusChanged && !revokeLegacy) return;
    try {
      await db
        .update(configPolicyFeatureLinks)
        .set({
          ...(revokeLegacy ? { executionAuthorityLegacy: 'revoked' as const } : {}),
          ...(statusChanged ? { executionAuthorityStatus: status, executionAuthorityStatusAt: new Date() } : {}),
        })
        .where(revokeLegacy
          ? and(
              eq(configPolicyFeatureLinks.id, featureLinkId),
              eq(configPolicyFeatureLinks.executionAuthorityLegacy, 'grandfathered'),
              isNull(configPolicyFeatureLinks.executionAuthorityGeneration),
            )
          : eq(configPolicyFeatureLinks.id, featureLinkId));
    } catch (error) {
      console.error('[SecurityScanQuarantineAuthority] failed to record authority status:', error);
      captureException(error);
    }
  };

  let authority: EffectiveSensitiveDataAuthority | null;
  if (hasEnvelope(link)) {
    if (!decodeSensitiveDataAuthority(link)) {
      await record('approver_invalid');
      return { allowed: false, reason: 'reapproval_required' };
    }
    try {
      authority = await resolveSensitiveDataAuthorityInCurrentSystemContext(link);
    } catch (error) {
      await record('lookup_failed');
      return unavailable(error);
    }
    if (!authority) {
      await record('approver_invalid');
      return { allowed: false, reason: 'authority_revoked' };
    }
  } else if (link.executionAuthorityLegacy === 'grandfathered') {
    try {
      authority = await resolveLegacyPrincipalExecuteAuthorityInCurrentSystemContext(
        { orgId: link.orgId, partnerId: link.partnerId },
        link.createdBy,
      );
    } catch (error) {
      await record('lookup_failed');
      return unavailable(error);
    }
    if (!authority) {
      // The creator no longer qualifies: re-approval is required even if they
      // regain the permission later.
      await record('approver_invalid', true);
      return { allowed: false, reason: 'reapproval_required' };
    }
  } else {
    return { allowed: false, reason: 'reapproval_required' };
  }

  await record('ok');

  let device;
  try {
    [device] = await db
      .select({ orgId: devices.orgId, siteId: devices.siteId, partnerId: organizations.partnerId })
      .from(devices)
      .innerJoin(organizations, eq(organizations.id, devices.orgId))
      .where(eq(devices.id, deviceId))
      .limit(1);
  } catch (error) {
    return unavailable(error);
  }
  const owner = link.orgId
    ? { orgId: link.orgId, partnerId: null }
    : { orgId: null, partnerId: link.partnerId! };
  if (!device || !authorityAdmitsDevice(authority, owner, device)) {
    return { allowed: false, reason: 'device_out_of_scope' };
  }
  return { allowed: true };
}
