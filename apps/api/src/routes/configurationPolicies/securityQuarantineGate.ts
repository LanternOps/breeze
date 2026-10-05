import type { AuthContext } from '../../middleware/auth';
import { hasSatisfiedMfa } from '../../middleware/auth';
import { PERMISSIONS, hasPermission, type UserPermissions } from '../../services/permissions';
import {
  captureSecurityQuarantineAuthority,
  securitySettingsAutoQuarantine,
} from '../../services/securityScanQuarantineAuthority';
import type { SensitiveDataAuthorityValues } from '../../services/sensitiveDataPolicyAuthority';

/**
 * Authorization for a `security` feature-link settings write.
 *
 * IOC auto-quarantine moves files on every device the policy reaches, with no
 * per-scan human in the loop, so saving settings whose EFFECTIVE value has it
 * on (the shared default is on) requires devices:execute + MFA and mints the
 * stored authority the scan dispatcher re-resolves. Keyed on the result of the
 * write: settings with auto-quarantine off keep the plain devices:write bar,
 * and turning it off is never gated (the fail-safe direction).
 */
export type SecurityQuarantineGateResult =
  | { allowed: true; executionAuthority: SensitiveDataAuthorityValues | null }
  | { allowed: false; body: { error: string; code: string } };

export function checkSecurityQuarantineWrite(
  auth: AuthContext,
  perms: UserPermissions | undefined,
  owner: { orgId: string | null; partnerId: string | null },
  inlineSettings: unknown,
): SecurityQuarantineGateResult {
  if (!securitySettingsAutoQuarantine(inlineSettings)) {
    return { allowed: true, executionAuthority: null };
  }

  // Fail closed: routes behind requirePermission always have permissions set.
  if (
    !perms
    || !hasPermission(perms, PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action)
  ) {
    return {
      allowed: false,
      body: {
        error:
          'Auto-quarantine moves files on every device this policy reaches, so enabling it requires the devices:execute permission. Turn auto-quarantine off to save these settings with devices:write.',
        code: 'AUTO_QUARANTINE_EXECUTE_REQUIRED',
      },
    };
  }

  if (!hasSatisfiedMfa(auth)) {
    return { allowed: false, body: { error: 'MFA required', code: 'MFA_REQUIRED' } };
  }

  const executionAuthority = captureSecurityQuarantineAuthority(auth, owner);
  if (!executionAuthority) {
    return {
      allowed: false,
      body: {
        error: 'You cannot approve auto-quarantine for every device this policy can reach.',
        code: 'AUTO_QUARANTINE_AUTHORITY_UNAVAILABLE',
      },
    };
  }
  return { allowed: true, executionAuthority };
}
